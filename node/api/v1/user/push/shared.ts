import { Response } from "express";
import { appConstants } from "../../../../constants";
import { createRateLimiter } from "../../../../layers/core/http/rate-limit";
import { sendUserLookupError } from "../user-errors";
import { log } from "../../../../layers/core/logger";

/*
 * Web push for the signed-in user's browsers (progress.md L.5 / BE 6.7). Any signed-in user;
 * pushes go to store members when their store gets a paid order.
 *
 *   GET  /user/push/config        → { publicKey: string | null }   null = push isn't set up
 *   POST /user/push/subscribe     { endpoint, keys: { p256dh, auth } } → 200 { ok: true }
 *        400 PUSH_ENDPOINT_NOT_ALLOWED unless it's a known push service (the server POSTs to it)
 *        503 PUSH_NOT_CONFIGURED without VAPID keys; 20 / user / hour → 429 RATE_LIMITED
 *   POST /user/push/unsubscribe   { endpoint } → 200 { ok: true } (also when it wasn't saved)
 *   POST /user/push/test          → 200 { delivered: n }   5 / user / 10 min → 429
 */
export const subscribeLimit = createRateLimiter({ windowMs: 60 * 60_000, max: 20 });
export const testLimit = createRateLimiter({ windowMs: 10 * 60_000, max: 5 });
export function resetPushLimitsForTests(): void {
  subscribeLimit.reset();
  testLimit.reset();
}

/* Push-service keys are base64url: p256dh is 65 bytes (87 chars), auth 16 bytes (22 chars). */
export const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
export const isKey = (v: unknown, min: number, max: number) => typeof v === "string" && v.length >= min && v.length <= max && B64URL.test(v);

export const fail500 = (res: Response, where: string) => (e: unknown) => {
  if (sendUserLookupError(e, res)) return;
  log.error({ err: e }, `In user/push/${where}`);
  res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
};

export function limited(res: Response, r: ReturnType<typeof testLimit.take>): boolean {
  if (r.ok) return false;
  res.setHeader("Retry-After", String(r.retryAfterSeconds));
  res.status(429).send({ code: "RATE_LIMITED", message: "Too many requests. Please try again later." });
  return true;
}

