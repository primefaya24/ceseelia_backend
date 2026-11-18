import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { CUSTOM_DOMAINS_ENABLED } from "../../../../config";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { createRateLimiter } from "../../../../layers/core/http/rate-limit";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { isUlid } from "../../../../layers/core/utils";
import { hostError, normalizeHost } from "../../../../layers/core/custom-domain";
import { DomainTakenError, StoreHasDomainError, getStoreDomain } from "../../../../layers/aws/dynamodb/dynamo-entities/domain";
import { getStoreAdminSettings } from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { domainView, recheckDomain, removeDomain, startDomain } from "../../../../layers/custom-domains";
import { log } from "../../../../layers/core/logger";

/*
 * A store's own domain (9.8 phase 2; plan in progress.md 9.8):
 *   GET  /store/domain/:storeId               (members)  → { domain, target, available }
 *   POST /store/domain/set    { storeId, host } (ADMIN)   → 201 { domain, target, available }
 *   POST /store/domain/check  { storeId }       (ADMIN)   → { … } (one step now; "Try again" after a failure)
 *   POST /store/domain/remove { storeId }       (ADMIN)   → { … domain: null }
 * `host` may be pasted as a URL; it must be a subdomain (`shop.example.com`). Needs a plan
 * (any plan; 402 PLAN_REQUIRED). 409 DOMAIN_TAKEN (another store), STORE_HAS_DOMAIN (one per
 * store: remove it first). 400 INVALID_DOMAIN / APEX_DOMAIN / OUR_DOMAIN. 503 when the server
 * isn't set up for custom domains. The sweep (every minute) moves a domain on by itself.
 */
export const domainLimits = {
  setPerStore: createRateLimiter({ windowMs: 60 * 60_000, max: 10 }),
  checkPerStore: createRateLimiter({ windowMs: 60 * 60_000, max: 60 }),
};

const storeIdFromBody = (req: Request) => req.body?.storeId;

export default function registerRoutes(router: Router): void {
  router.get("/:storeId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (r) => typeof r.params.storeId === "string",
      (r) => isUlid(r.params.storeId),
      getCore,
      true,
      storeMember((r) => r.params.storeId)
    );
  });
  router.post("/set", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (r) => isUlid(r.body?.storeId) && typeof r.body?.host === "string" && r.body.host.length <= 300,
      () => true,
      setCore,
      true,
      storeMember(storeIdFromBody, "ADMIN")
    );
  });
  router.post("/check", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, (r) => isUlid(r.body?.storeId), () => true, checkCore, true, storeMember(storeIdFromBody, "ADMIN"));
  });
  router.post("/remove", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, (r) => isUlid(r.body?.storeId), () => true, removeCore, true, storeMember(storeIdFromBody, "ADMIN"));
  });
}

function unavailable(res: Response): boolean {
  if (CUSTOM_DOMAINS_ENABLED) return false;
  res.status(503).send({ code: "DOMAINS_UNAVAILABLE", message: "Custom domains aren't available yet." });
  return true;
}

function limited(res: Response, limiter: ReturnType<typeof createRateLimiter>, key: string): boolean {
  const r = limiter.take(key);
  if (r.ok) return false;
  res.status(429).send({ code: "RATE_LIMITED", message: "Too many changes. Please try again later.", retryAfter: r.retryAfterSeconds });
  return true;
}

function failed(res: Response, e: unknown, where: string): void {
  log.error({ err: e }, `In store/domain/${where}`);
  res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
}

async function getCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    res.send(domainView(await getStoreDomain(String(req.params.storeId))));
  } catch (e) {
    failed(res, e, "get");
  }
}

async function setCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  if (unavailable(res)) return;
  const storeId = String(req.body.storeId);
  const host = normalizeHost(String(req.body.host));
  const problem = hostError(host);
  if (problem) {
    const code = problem === "APEX" ? "APEX_DOMAIN" : problem === "OURS" ? "OUR_DOMAIN" : "INVALID_DOMAIN";
    res.status(400).send({ code, message: "Enter a subdomain of a domain you own, like shop.example.com." });
    return;
  }
  if (limited(res, domainLimits.setPerStore, storeId)) return;
  try {
    const settings = await getStoreAdminSettings(storeId);
    if (!settings) {
      res.status(404).send({ code: "STORE_NOT_FOUND", message: "Store not found" });
      return;
    }
    if (settings.lifecycle.plan === "NONE") {
      res.status(402).send({ code: "PLAN_REQUIRED", message: "Your own domain comes with a plan." });
      return;
    }
    const domain = await startDomain(storeId, host);
    log.info({ storeId, host, status: domain.status }, "Custom domain set");
    res.status(201).send(domainView(domain));
  } catch (e) {
    if (e instanceof DomainTakenError) {
      res.status(409).send({ code: "DOMAIN_TAKEN", message: e.message });
      return;
    }
    if (e instanceof StoreHasDomainError) {
      res.status(409).send({ code: "STORE_HAS_DOMAIN", message: e.message });
      return;
    }
    failed(res, e, "set");
  }
}

async function checkCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  if (unavailable(res)) return;
  const storeId = String(req.body.storeId);
  if (limited(res, domainLimits.checkPerStore, storeId)) return;
  try {
    const d = await getStoreDomain(storeId);
    if (!d) {
      res.status(404).send({ code: "NO_DOMAIN", message: "This store has no domain." });
      return;
    }
    res.send(domainView(await recheckDomain(d)));
  } catch (e) {
    failed(res, e, "check");
  }
}

async function removeCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const storeId = String(req.body.storeId);
  try {
    const d = await getStoreDomain(storeId);
    if (d) {
      await removeDomain(d);
      log.info({ storeId, host: d.host }, "Custom domain removed");
    }
    res.send(domainView(null));
  } catch (e) {
    failed(res, e, "remove");
  }
}
