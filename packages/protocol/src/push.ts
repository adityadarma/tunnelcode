import { z } from 'zod';

/** Longest endpoint URL a push service is expected to hand out. */
const ENDPOINT_MAX_LENGTH = 2048;

/**
 * A push subscription as the browser reports it.
 *
 * The endpoint is the URL the push service listens on, and the two keys are what
 * the payload is encrypted for. All three come from the browser rather than from
 * this project, so they are checked rather than trusted: the endpoint has to be an
 * https URL, because that is the only scheme a push service is reachable on and an
 * unchecked one would be a URL the server can be made to post to. See ADR-045.
 */
export const pushSubscriptionSchema = z.object({
  endpoint: z.url().max(ENDPOINT_MAX_LENGTH).startsWith('https://'),
  keys: z.object({
    /** The subscriber's public P-256 point, base64url, 65 bytes uncompressed. */
    p256dh: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    /** The 16 byte shared authentication secret, base64url. */
    auth: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[A-Za-z0-9_-]+$/),
  }),
});

/**
 * Body sent to forget a subscription.
 *
 * Only the endpoint, since that is what identifies it. Nothing else about a
 * subscription is needed to stop sending to it.
 */
export const pushUnsubscribeSchema = z.object({
  endpoint: z.url().max(ENDPOINT_MAX_LENGTH).startsWith('https://'),
});

export type PushSubscriptionRequest = z.infer<typeof pushSubscriptionSchema>;
export type PushUnsubscribeRequest = z.infer<typeof pushUnsubscribeSchema>;
