/*
 * 9.2 Request limits for the whole API, on top of the per-route limits that already guard the
 * costly or abusable routes (quote, create-order, order-status, contact-store, create-store,
 * update-info, Go Live: `rate-limit.ts`).
 *
 *   - apiRateLimit: every /api/v1 request, per client IP (IPv6 per /56). A shopper browsing,
 *     or a merchant's dashboard, stays far below it; a script hammering the API doesn't.
 *   - publicReadRateLimit: the unauthenticated storefront reads, tighter, because anyone can
 *     call them and each one reads several DynamoDB rows.
 * Stripe's webhooks are mounted before both and are never limited (Stripe retries, and a
 * dropped event is worse than a busy minute). Counts are in memory: fine for the one API
 * server; with more than one, give express-rate-limit a shared store.
 *
 * The client IP is `req.ip`, which only trusts TRUST_PROXY_HOPS (S.13), so it can't be spoofed.
 */
import express, { ErrorRequestHandler, RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { log, maskEmails } from "../logger";

export const API_RATE_LIMIT = { windowMs: 60_000, max: 300 };
export const PUBLIC_READ_RATE_LIMIT = { windowMs: 60_000, max: 120 };

/* Paths (under /api/v1) that anyone can read without signing in. */
export const PUBLIC_READ_PATHS = ["/api/v1/store/public", "/api/v1/store/inventory/get-data-public"];

function limiter(opts: { windowMs: number; max: number }, what: string): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res, _next, options) => {
      log.warn({ limit: what, path: maskEmails(req.baseUrl + req.path) }, "rate limited");
      res.status(options.statusCode).send({ code: "RATE_LIMITED", message: "Too many requests. Please try again shortly." });
    },
  });
}

/* New counters per app, so every createApp() (and every test file) starts fresh. */
export function apiRateLimit(): RequestHandler {
  return limiter(API_RATE_LIMIT, "api");
}
export function publicReadRateLimit(): RequestHandler {
  return limiter(PUBLIC_READ_RATE_LIMIT, "public");
}

/*
 * JSON body limits. Nothing the API takes is anywhere near 100 KB (the biggest is an item with
 * 100 variant rows, ~20 KB), so that is the default; the two big forms get a little more room.
 * The first parser that matches reads the body; later ones see it is already parsed and skip.
 */
export const JSON_BODY_LIMIT = "100kb";
export const LARGE_JSON_BODY_LIMIT = "256kb";
export const LARGE_BODY_PATHS = ["/api/v1/store/inventory/create-item", "/api/v1/store/update-settings"];

export function jsonBodyParsers(app: express.Express): void {
  app.use(LARGE_BODY_PATHS, express.json({ limit: LARGE_JSON_BODY_LIMIT }));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
}

/* A body that is too big or isn't JSON gets a JSON answer, not Express's HTML error page. */
export const bodyErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  const type = (err as { type?: string })?.type;
  if (type === "entity.too.large") {
    res.status(413).send({ code: "BODY_TOO_LARGE", message: "Request body too large" });
    return;
  }
  if (type === "entity.parse.failed") {
    res.status(400).send({ code: "INVALID_JSON", message: "Request body isn't valid JSON" });
    return;
  }
  next(err);
};

/* Last in the chain: anything a route let escape is logged and answered with a plain 500. */
export const finalErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  log.error({ err, path: maskEmails(req.path) }, "unhandled error");
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).send({ message: "Internal server error" });
};
