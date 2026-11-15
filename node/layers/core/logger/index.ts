/*
 * 9.1 Structured logging. One pino logger for the whole API: JSON lines on stdout (Docker keeps
 * them; `docker logs` / CloudWatch read them), pretty in a dev terminal.
 *
 * No PII and no secrets in logs:
 *   - known sensitive keys are redacted wherever they appear in a logged object (REDACT_PATHS);
 *   - errors go through `errSerializer`, which keeps only the type, message, stack and a few
 *     safe ids. AWS and Stripe errors carry the request, the response and sometimes the item;
 *     none of that is logged;
 *   - request lines log the path with emails masked, never the query string or headers, and
 *     the client IP truncated (`truncateIp`).
 * Log ids (storeId, orderId, userId ULIDs, Stripe event ids), never names, emails or addresses.
 *
 * Every line logged while a request is being handled carries its `reqId` (AsyncLocalStorage),
 * so a route's error can be matched to its request line without passing anything around.
 */
import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import pino, { DestinationStream, Logger, LoggerOptions } from "pino";
import type { NextFunction, Request, Response } from "express";
import { IN_DEV, STAGE } from "../../../config";

const requestContext = new AsyncLocalStorage<{ reqId: string }>();

/** The current request's id, if this code runs inside a request. */
export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.reqId;
}

/* Keys that never reach a log line, at the top level or one/two levels down. */
const SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "password",
  "token",
  "accessToken",
  "idToken",
  "refreshToken",
  "secret",
  "apiKey",
  "email",
  "emailaddress",
  "customerEmail",
  "phone",
  "address",
  "addressLine1",
  "addressLine2",
  "postalCode",
  "name",
  "customerName",
  "fcmToken",
];
export const REDACT_PATHS = SENSITIVE_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]);

/* Error fields that are safe and useful: AWS (`$metadata`), Stripe (`type`, `code`, `requestId`). */
export function errSerializer(e: unknown, depth = 0): Record<string, unknown> {
  if (!(e instanceof Error)) {
    return { message: typeof e === "string" ? maskEmails(e) : "non-error thrown", kind: typeof e };
  }
  const any = e as Error & {
    code?: unknown;
    type?: unknown;
    statusCode?: unknown;
    requestId?: unknown;
    $metadata?: { httpStatusCode?: number; requestId?: string };
  };
  const out: Record<string, unknown> = {
    type: e.name,
    message: maskEmails(e.message),
    stack: e.stack ? maskEmails(e.stack) : undefined,
  };
  if (typeof any.code === "string" || typeof any.code === "number") out.code = any.code;
  if (typeof any.type === "string") out.stripeType = any.type;
  if (typeof any.statusCode === "number") out.statusCode = any.statusCode;
  if (typeof any.requestId === "string") out.requestId = any.requestId;
  if (any.$metadata) {
    out.httpStatusCode = any.$metadata.httpStatusCode;
    out.awsRequestId = any.$metadata.requestId;
  }
  const cause = (e as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== e && depth < 3) out.cause = errSerializer(cause, depth + 1);
  return out;
}

const EMAIL_RE = /[^\s/@"'<>]+(?:@|%40)[^\s/"'<>]+\.[a-z]{2,}/gi;
/** Replaces anything that looks like an email (also URL-encoded) with `[email]`. */
export function maskEmails(s: string): string {
  return s.replace(EMAIL_RE, "[email]");
}

/** IPv4 → /24 (last octet 0), IPv6 → /48. Enough to spot abuse, not to identify a shopper. */
export function truncateIp(ip: string | undefined): string {
  if (!ip) return "unknown";
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4.replace(/\.\d+$/, ".0");
  if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + "::";
  return "unknown";
}

/** The API's logger; tests pass their own stream and level to read what would be logged. */
export function buildLogger(destination?: DestinationStream, levelOverride?: string): Logger {
  const inTests = !!process.env.VITEST;
  const level = levelOverride ?? process.env.LOG_LEVEL ?? (inTests ? "silent" : IN_DEV ? "debug" : "info");
  const pretty = !destination && IN_DEV && !inTests && process.stdout.isTTY && process.env.LOG_PRETTY !== "false";
  const options: LoggerOptions = {
    level,
    base: { stage: STAGE },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    serializers: { err: errSerializer, error: errSerializer },
    mixin() {
      const reqId = currentRequestId();
      return reqId ? { reqId } : {};
    },
    // pino-pretty is a dev dependency: only used in a dev terminal, never in the prod image.
    transport: pretty ? { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname,stage" } } : undefined,
  };
  return destination ? pino(options, destination) : pino(options);
}

export const log: Logger = buildLogger();

/** A child logger for one area, e.g. `logFor("order sweep")` → every line has `area`. */
export function logFor(area: string): Logger {
  return log.child({ area });
}

/* A request id from nginx (`X-Request-Id: $request_id`) is kept if it looks like one. */
const INCOMING_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Express middleware, first in the chain: gives the request an id (echoed in `X-Request-Id`),
 * runs the rest of the chain inside its context, and logs one line when the response is done.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  requestLoggerWith(log)(req, res, next);
}

export function requestLoggerWith(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.get("x-request-id");
    const reqId = incoming && INCOMING_ID_RE.test(incoming) ? incoming : randomUUID();
    res.setHeader("X-Request-Id", reqId);
    const started = process.hrtime.bigint();

    res.on("finish", () => {
      // /healthz is probed every few seconds by Docker; it would drown the log.
      if (req.path === "/healthz" && res.statusCode === 200) return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const line = {
        reqId,
        method: req.method,
        host: req.hostname,
        // originalUrl: the full path (req.path is relative to the router that handled it); no query.
        path: maskEmails(req.originalUrl.split("?")[0]),
        status: res.statusCode,
        ms: Math.round(ms),
        ip: truncateIp(req.ip),
      };
      if (res.statusCode >= 500) logger.error(line, "request");
      else if (res.statusCode >= 400) logger.warn(line, "request");
      else logger.info(line, "request");
    });

    requestContext.run({ reqId }, () => next());
  };
}
