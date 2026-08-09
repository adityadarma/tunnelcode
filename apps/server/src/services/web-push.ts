import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * Web push, written against the specifications rather than pulled in as a
 * dependency.
 *
 * Everything it needs is in node:crypto: ECDH on P-256, HKDF over HMAC-SHA-256,
 * AES-128-GCM, and ECDSA for the signature. The two documents this implements are
 * RFC 8291 for the encrypted payload and RFC 8292 for the signature that identifies
 * the sender. See ADR-045.
 */

const CURVE = 'prime256v1';

/** Size of the AES key, the nonce, and the salt, in bytes, as RFC 8291 fixes them. */
const KEY_LENGTH = 16;
const NONCE_LENGTH = 12;
const SALT_LENGTH = 16;

/**
 * Record size written into the header.
 *
 * One record carries the whole payload here, so this is only a ceiling the
 * subscriber reads before allocating. 4096 is what every implementation uses.
 */
const RECORD_SIZE = 4096;

/** How long a signature is accepted for. Below the 24 hours RFC 8292 allows. */
const JWT_LIFETIME_SECONDS = 12 * 60 * 60;

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url. */
  publicKey: string;
  /** The private scalar, base64url. */
  privateKey: string;
}

export interface PushSubscription {
  endpoint: string;
  /** The subscriber's public P-256 point, base64url. */
  p256dh: string;
  /** The subscriber's authentication secret, base64url. */
  auth: string;
}

function base64url(value: Buffer): string {
  return value.toString('base64url');
}

function fromBase64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function hmac(key: Buffer, message: Buffer): Buffer {
  return createHmac('sha256', key).update(message).digest();
}

/**
 * One round of HKDF-Expand, which is all this needs: every output here is at most
 * 32 bytes, so the counter never goes past one.
 */
function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  return hmac(prk, Buffer.concat([info, Buffer.of(1)])).subarray(0, length);
}

/** An info string as RFC 8188 writes them: a label, then a zero byte. */
function contentEncodingInfo(label: string): Buffer {
  return Buffer.concat([Buffer.from(`Content-Encoding: ${label}`, 'ascii'), Buffer.of(0)]);
}

/** A fresh signing identity. Generated once per deployment and then stored. */
export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: CURVE });
  const jwk = publicKey.export({ format: 'jwk' });
  const secret = privateKey.export({ format: 'jwk' });

  if (jwk.x === undefined || jwk.y === undefined || secret.d === undefined) {
    throw new Error('Cannot generate a push signing key.');
  }

  return {
    // 0x04 is what marks a point as uncompressed, which is the form a browser
    // expects the application server key in.
    publicKey: base64url(Buffer.concat([Buffer.of(4), fromBase64url(jwk.x), fromBase64url(jwk.y)])),
    privateKey: secret.d,
  };
}

/**
 * Rebuilds a signing key from the stored scalar.
 *
 * The public point is derived rather than stored alongside it, so the two can
 * never disagree.
 */
function signingKey(privateKey: Buffer): KeyObject {
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(privateKey);
  const point = ecdh.getPublicKey();

  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: base64url(privateKey),
      x: base64url(point.subarray(1, 33)),
      y: base64url(point.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

export interface AuthorizationOptions {
  keys: VapidKeys;
  /** Scheme and host of the endpoint, which is what the token is addressed to. */
  audience: string;
  /** How a push service can reach whoever runs this server. */
  subject: string;
  /** Only passed by tests, so a signature can be checked against a fixed clock. */
  now?: number;
}

/**
 * The Authorization header a push service accepts.
 *
 * A signed statement of who is sending, which is what keeps a subscription usable
 * only by the server that created it: the browser subscribed with this public key,
 * so a message signed by anything else is refused. See RFC 8292.
 */
export function vapidAuthorization(options: AuthorizationOptions): string {
  const issuedAt = Math.floor((options.now ?? Date.now()) / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8'));
  const payload = base64url(
    Buffer.from(
      JSON.stringify({
        aud: options.audience,
        exp: issuedAt + JWT_LIFETIME_SECONDS,
        sub: options.subject,
      }),
      'utf8',
    ),
  );

  const unsigned = `${header}.${payload}`;
  // ES256 wants the raw pair of integers, not the DER structure Node writes by
  // default. A DER signature here is accepted by nothing.
  const signature = sign('sha256', Buffer.from(unsigned, 'ascii'), {
    key: signingKey(fromBase64url(options.keys.privateKey)),
    dsaEncoding: 'ieee-p1363',
  });

  return `vapid t=${unsigned}.${base64url(signature)}, k=${options.keys.publicKey}`;
}

export interface EncryptOptions {
  subscription: PushSubscription;
  /** The message, already serialized. */
  payload: string;
  /** Only passed by tests, which have to reproduce a published record exactly. */
  salt?: Buffer;
  /** Only passed by tests, for the same reason. */
  ephemeralPrivateKey?: Buffer;
}

/**
 * Encrypts a payload for one subscriber, producing the body to POST.
 *
 * The result is a single aes128gcm record: salt, record size, the sender's public
 * key, then the ciphertext. Only the browser that subscribed can read it, so the
 * push service in between carries something it cannot open. See RFC 8291.
 */
export function encryptPushPayload(options: EncryptOptions): Buffer {
  const subscriberKey = fromBase64url(options.subscription.p256dh);
  const authSecret = fromBase64url(options.subscription.auth);

  const ecdh = createECDH(CURVE);

  if (options.ephemeralPrivateKey === undefined) {
    ecdh.generateKeys();
  } else {
    ecdh.setPrivateKey(options.ephemeralPrivateKey);
  }

  const senderKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(subscriberKey);

  // The authentication secret is the salt of the first extraction, which is what
  // ties the derived key to this subscription and not merely to the two key pairs.
  const authPrk = hmac(authSecret, sharedSecret);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info', 'ascii'),
    Buffer.of(0),
    subscriberKey,
    senderKey,
  ]);
  const inputKeyMaterial = expand(authPrk, keyInfo, 32);

  const salt = options.salt ?? randomBytes(SALT_LENGTH);
  const prk = hmac(salt, inputKeyMaterial);
  const contentEncryptionKey = expand(prk, contentEncodingInfo('aes128gcm'), KEY_LENGTH);
  const nonce = expand(prk, contentEncodingInfo('nonce'), NONCE_LENGTH);

  const cipher = createCipheriv('aes-128-gcm', contentEncryptionKey, nonce);
  const ciphertext = Buffer.concat([
    // 0x02 marks the end of the payload and the last record at once. There is only
    // ever one record here, so no padding follows it.
    cipher.update(Buffer.concat([Buffer.from(options.payload, 'utf8'), Buffer.of(2)])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(SALT_LENGTH + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_LENGTH);
  header.writeUInt8(senderKey.length, SALT_LENGTH + 4);

  return Buffer.concat([header, senderKey, ciphertext]);
}
