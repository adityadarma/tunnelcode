import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac } from 'node:crypto';
import test from 'node:test';
import {
  encryptPushPayload,
  generateVapidKeys,
  vapidAuthorization,
} from '../dist/services/web-push.js';

/**
 * The published example from RFC 8291 section 5.
 *
 * Encryption is only useful if the receiver can open it, and the receiver is a
 * browser this project cannot run. Reproducing the specification's own record byte
 * for byte is what pins the derivation: a wrong info string or a swapped salt still
 * produces a plausible looking record, and only a fixed vector catches it.
 */
const RFC_8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  subscriberPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  record:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

void test('encrypts a payload exactly as RFC 8291 does', () => {
  const record = encryptPushPayload({
    subscription: {
      endpoint: 'https://push.example.com/x',
      p256dh: RFC_8291.subscriberPublic,
      auth: RFC_8291.authSecret,
    },
    payload: RFC_8291.plaintext,
    salt: Buffer.from(RFC_8291.salt, 'base64url'),
    ephemeralPrivateKey: Buffer.from(RFC_8291.senderPrivate, 'base64url'),
  });

  assert.equal(record.toString('base64url'), RFC_8291.record);
});

void test('produces a record the subscriber can open', () => {
  // A second pair standing in for a browser, so the round trip is checked with a
  // random salt and a random ephemeral key rather than only the fixed vector.
  const subscriber = createECDH('prime256v1');
  subscriber.generateKeys();
  const authSecret = Buffer.alloc(16, 7);
  const payload = JSON.stringify({ kind: 'permission', title: 'Approval needed' });

  const record = encryptPushPayload({
    subscription: {
      endpoint: 'https://push.example.com/x',
      p256dh: subscriber.getPublicKey().toString('base64url'),
      auth: authSecret.toString('base64url'),
    },
    payload,
  });

  const salt = record.subarray(0, 16);
  const keyLength = record.readUInt8(20);
  const senderKey = record.subarray(21, 21 + keyLength);
  const ciphertext = record.subarray(21 + keyLength);

  const hmac = (key: Buffer, message: Buffer): Buffer =>
    createHmac('sha256', key).update(message).digest();
  const expand = (prk: Buffer, info: Buffer, length: number): Buffer =>
    hmac(prk, Buffer.concat([info, Buffer.of(1)])).subarray(0, length);
  const info = (label: string): Buffer =>
    Buffer.concat([Buffer.from(`Content-Encoding: ${label}`, 'ascii'), Buffer.of(0)]);

  const shared = subscriber.computeSecret(senderKey);
  const inputKeyMaterial = expand(
    hmac(authSecret, shared),
    Buffer.concat([
      Buffer.from('WebPush: info', 'ascii'),
      Buffer.of(0),
      subscriber.getPublicKey(),
      senderKey,
    ]),
    32,
  );
  const prk = hmac(salt, inputKeyMaterial);

  const decipher = createDecipheriv(
    'aes-128-gcm',
    expand(prk, info('aes128gcm'), 16),
    expand(prk, info('nonce'), 12),
  );
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));

  const opened = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);

  // The trailing byte is the delimiter that says this was the last record.
  assert.equal(opened.readUInt8(opened.length - 1), 2);
  assert.equal(opened.subarray(0, opened.length - 1).toString('utf8'), payload);
});

void test('signs an authorization naming the endpoint host and the sending key', () => {
  const keys = generateVapidKeys();
  const header = vapidAuthorization({
    keys,
    audience: 'https://push.example.com',
    subject: 'mailto:someone@example.com',
    now: 1_700_000_000_000,
  });

  const token = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header);
  assert.notEqual(token, null);
  assert.equal(token?.[2], keys.publicKey);

  const parts = String(token?.[1]).split('.');
  const claims: unknown = JSON.parse(Buffer.from(String(parts[1]), 'base64url').toString('utf8'));

  assert.deepEqual(claims, {
    aud: 'https://push.example.com',
    exp: 1_700_000_000 + 12 * 60 * 60,
    sub: 'mailto:someone@example.com',
  });

  // Raw r||s, which is the only form ES256 accepts.
  assert.equal(Buffer.from(String(parts[2]), 'base64url').length, 64);
});
