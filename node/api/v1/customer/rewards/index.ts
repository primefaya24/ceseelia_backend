import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { MAX_LENGTH } from "../../../../constants/input-limits";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { createRateLimiter, RateLimiter } from "../../../../layers/core/http/rate-limit";
import { sendPublicError } from "../../../../layers/core/http/public-storefront";
import { getClientIp, isUlid } from "../../../../layers/core/utils";
import { isEmailOrEmpty } from "../../../../layers/core/utils/validation";
import { RewardsProgram, maskEmail, rewardsProgram } from "../../../../layers/core/rewards";
import { getPublicStoreSettings } from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { customerIdFor } from "../../../../layers/aws/dynamodb/dynamo-entities/customer";
import {
  CODE_LIMITS,
  CODE_TTL_MS,
  checkCode,
  createSession,
  deleteSession,
  getRewardsAccount,
  getSession,
  issueCode,
  normEmail,
  takeEmailLimit,
} from "../../../../layers/aws/dynamodb/dynamo-entities/rewards";
import { sendRewardsCode } from "../../../../layers/notifications/order-emails";
import { log } from "../../../../layers/core/logger";

/*
 * Shopper rewards (progress.md L.7 / 7.4). The shopper proves their email with a 6-digit code;
 * that gives a session (header `X-Rewards-Token`) for this store only.
 *
 *   POST /customer/rewards/request-code { storeId, email } → 200 { sent: true } always (whether
 *        or not the email has points, so it can't be used to learn who shops where). A code is
 *        emailed only to an email that has a rewards account at the store, so this can't spam
 *        strangers. Limits: 3 per email per 15 min and 10 a day (kept in the table), 5 per IP per
 *        10 min and 20 a day, 200 per store an hour → 429.
 *   POST /customer/rewards/verify { storeId, email, code } → 200 { token, expiresAt, account }.
 *        400 CODE_WRONG / CODE_EXPIRED (no code, used, 5 wrong guesses, or past 10 minutes).
 *        Guesses: 5 per code (counted in the table before comparing), 20 per IP per 10 min.
 *   GET  /customer/rewards/account/:storeId → { account } (401 REWARDS_SIGNED_OUT)
 *   POST /customer/rewards/sign-out { storeId } → 200 (the session is deleted)
 * 409 REWARDS_OFF when the store has no program running.
 */
export const requestIpLimit = createRateLimiter({ windowMs: 10 * 60_000, max: 5 });
export const requestIpDayLimit = createRateLimiter({ windowMs: 24 * 3600_000, max: 20 });
export const requestStoreLimit = createRateLimiter({ windowMs: 3600_000, max: 200 });
export const verifyIpLimit = createRateLimiter({ windowMs: 10 * 60_000, max: 20 });
export const accountIpLimit = createRateLimiter({ windowMs: 60_000, max: 60 });
export const resetRewardsLimitsForTests = (): void =>
  [requestIpLimit, requestIpDayLimit, requestStoreLimit, verifyIpLimit, accountIpLimit].forEach((l) => l.reset());

const isStr = (v: unknown): v is string => typeof v === "string";
const goodEmail = (v: string) => v.trim().length > 0 && v.trim().length <= MAX_LENGTH.email && isEmailOrEmpty(v.trim());

function tooMany(res: Response, ...checks: [RateLimiter, string][]): boolean {
  for (const [limiter, key] of checks) {
    const r = limiter.take(key);
    if (!r.ok) {
      res.set("Retry-After", String(r.retryAfterSeconds));
      res.status(429).send({ code: "RATE_LIMITED", message: "Too many tries. Please wait a few minutes and try again." });
      return true;
    }
  }
  return false;
}

/** What the shopper sees of the program (all of it is on the public storefront anyway). */
export const programView = (p: RewardsProgram) => ({ label: p.label, pointsPerUnit: p.pointsPerUnit, cost: p.cost, kind: p.kind, value: p.value });

async function programOr409(res: Response, storeId: string): Promise<RewardsProgram | null> {
  const program = rewardsProgram(await getPublicStoreSettings(storeId));
  if (!program) res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code: "REWARDS_OFF", message: "This store has no rewards right now." });
  return program;
}

const accountView = async (storeId: string, customerId: string, email: string) => {
  const a = await getRewardsAccount(storeId, customerId);
  return { email: maskEmail(email), balance: a?.balance ?? 0 };
};

export default function registerRoute(router: Router): void {
  router.post("/rewards/request-code", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => isStr(req.body?.storeId) && isStr(req.body?.email),
      (req) => isUlid(req.body.storeId) && goodEmail(req.body.email),
      requestCode,
      false
    );
  });
  router.post("/rewards/verify", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => isStr(req.body?.storeId) && isStr(req.body?.email) && isStr(req.body?.code),
      (req) => isUlid(req.body.storeId) && goodEmail(req.body.email) && req.body.code.trim().length <= 12,
      verify,
      false
    );
  });
  router.get("/rewards/account/:storeId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, (req) => isStr(req.header("x-rewards-token")), (req) => isUlid(req.params.storeId), account, false);
  });
  router.post("/rewards/sign-out", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, (req) => isStr(req.body?.storeId) && isStr(req.header("x-rewards-token")), (req) => isUlid(req.body.storeId), signOut, false);
  });
}

async function requestCode(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const ip = getClientIp(req) ?? "unknown";
  const storeId = String(req.body.storeId);
  if (tooMany(res, [requestIpLimit, `ip:${ip}`], [requestIpDayLimit, `ip:${ip}`], [requestStoreLimit, `store:${storeId}`])) return;
  try {
    const settings = await getPublicStoreSettings(storeId);
    if (!rewardsProgram(settings)) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code: "REWARDS_OFF", message: "This store has no rewards right now." });
      return;
    }
    const email = normEmail(req.body.email);
    const customerId = customerIdFor(email);
    const now = Date.now();
    // Counted for every email, with points or not, so the answer says nothing about the email.
    if (!(await takeEmailLimit(storeId, customerId, CODE_LIMITS, now))) {
      res.set("Retry-After", "900");
      res.status(429).send({ code: "RATE_LIMITED", message: "Too many codes for this email. Please try again later." });
      return;
    }
    // The same reads and writes either way (a code is always made), so timing says nothing
    // either; only an email with a rewards account is sent it.
    const [account, code] = await Promise.all([getRewardsAccount(storeId, customerId), issueCode(storeId, customerId, now)]);
    if (account) {
      // Not awaited: the answer takes the same time whether an email goes out or not.
      void sendRewardsCode(email, String(settings.storeInfo?.storeName || "the store"), code, CODE_TTL_MS / 60_000);
    }
    log.info({ storeId, sent: !!account }, "Rewards code requested");
    res.send({ sent: true });
  } catch (e) {
    sendPublicError(res, e);
  }
}

async function verify(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const ip = getClientIp(req) ?? "unknown";
  if (tooMany(res, [verifyIpLimit, `ip:${ip}`])) return;
  const storeId = String(req.body.storeId);
  try {
    if (!(await programOr409(res, storeId))) return;
    const email = normEmail(req.body.email);
    const customerId = customerIdFor(email);
    const now = Date.now();
    const result = await checkCode(storeId, customerId, req.body.code.trim(), now);
    if (result !== "OK") {
      log.warn({ storeId, result }, "Rewards code refused");
      res.status(appConstants.HTTP_STATUS_CODE_BAD_REQUEST).send(
        result === "WRONG"
          ? { code: "CODE_WRONG", message: "That code isn't right. Check the email and try again." }
          : { code: "CODE_EXPIRED", message: "That code has expired or was used up. Ask for a new one." }
      );
      return;
    }
    const session = await createSession(storeId, email, now);
    res.send({ token: session.token, expiresAt: session.expiresAt, account: await accountView(storeId, customerId, email) });
  } catch (e) {
    sendPublicError(res, e);
  }
}

const signedOut = (res: Response) =>
  res.status(401).send({ code: "REWARDS_SIGNED_OUT", message: "Confirm your email again to use your points." });

async function account(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  if (tooMany(res, [accountIpLimit, `ip:${getClientIp(req) ?? "unknown"}`])) return;
  const storeId = String(req.params.storeId);
  try {
    const program = await programOr409(res, storeId);
    if (!program) return;
    const session = await getSession(storeId, req.header("x-rewards-token") ?? "", Date.now());
    if (!session) {
      signedOut(res);
      return;
    }
    res.send({ account: await accountView(storeId, session.customerId, session.email), program: programView(program) });
  } catch (e) {
    sendPublicError(res, e);
  }
}

async function signOut(req: Request, res: Response): Promise<void> {
  try {
    await deleteSession(String(req.body.storeId), req.header("x-rewards-token") ?? "");
    res.send({ ok: true });
  } catch (e) {
    sendPublicError(res, e);
  }
}
