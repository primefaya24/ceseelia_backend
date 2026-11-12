// Imports
import { Request, Response, Router } from "express";
import geoip from "geoip-lite";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { MAX_COUNT, MAX_LENGTH } from "../../../../constants/input-limits";
import { getPublicStoreInventoryData } from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { sendPublicError } from "../../../../layers/core/http/public-storefront";
import { createRateLimiter } from "../../../../layers/core/http/rate-limit";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { Fulfilment, priceLines, QuoteLineInput } from "../../../../layers/core/pricing";
import { getClientIp, isUlid, resolveCaProvinceFromGeo } from "../../../../layers/core/utils";

/*
 * POST /customer/quote (public, no auth; progress.md 4.3 / WA 4.4)
 * Body { storeId, currency, fulfilment?: "PICKUP" | "DELIVERY",
 *        lines: [{ itemId, quantity, params: [{ label, values }] }] }.
 * Canadian tax on a delivery (QA Q.23) is an estimate for the province the shopper's IP is in
 * (geo-IP, never stored or logged), else the store's own; `taxRegion.estimated` says so. A VPN
 * only changes this estimate: the order is taxed on its delivery address at checkout (Stage 5).
 * Without `fulfilment` the store's first option (pickup, else delivery) is priced (4.2).
 * Prices the cart with `priceLines` (4.1) against the store's public data, so hidden items,
 * hidden categories and currencies the store doesn't offer are never priced. Always 200 with
 * the quote: line problems are in `lines[i].error`, a currency the store doesn't offer is
 * `error: CURRENCY_NOT_OFFERED`, and `ok` is true only when every line can be bought.
 *   - 400 for a malformed body (more than 50 lines, oversized params, wrong types).
 *   - The store's 404s (STORE_NOT_FOUND / STORE_UNAVAILABLE).
 *   - 60 quotes per IP per minute (the cart re-quotes on every change) → 429 RATE_LIMITED.
 */
export const quoteLimit = createRateLimiter({ windowMs: 60_000, max: 60 });

export default function registerRoute(router: Router): void {
  router.post("/quote", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore, false);
  });
}

const isString = (v: unknown): v is string => typeof v === "string";

function isLinePure(l: unknown): boolean {
  const line = l as QuoteLineInput;
  return (
    typeof line === "object" &&
    line !== null &&
    isString(line.itemId) &&
    typeof line.quantity === "number" &&
    (line.params === undefined ||
      (Array.isArray(line.params) &&
        line.params.every(
          (p) =>
            typeof p === "object" &&
            p !== null &&
            isString(p.label) &&
            Array.isArray(p.values) &&
            p.values.every(isString)
        )))
  );
}

function pureRequestParams(req: Request): boolean {
  const b = req.body;
  return (
    isString(b?.storeId) &&
    isString(b?.currency) &&
    (b.fulfilment === undefined || b.fulfilment === "PICKUP" || b.fulfilment === "DELIVERY") &&
    Array.isArray(b?.lines) &&
    b.lines.every(isLinePure)
  );
}

/* Sizes only; what the items allow is priceLines' job (it answers per line). */
function validRequestParams(req: Request): boolean {
  const lines = req.body.lines as QuoteLineInput[];
  return (
    isUlid(req.body.storeId) &&
    req.body.currency.length <= 3 &&
    lines.length <= MAX_COUNT.cartLines &&
    lines.every(
      (l) =>
        l.itemId.length <= 26 &&
        (l.params ?? []).length <= MAX_COUNT.itemParams &&
        (l.params ?? []).every(
          (p) =>
            p.label.length <= MAX_LENGTH.paramLabel &&
            p.values.length <= MAX_COUNT.paramOptions &&
            p.values.every((v) => v.length <= MAX_LENGTH.paramOption)
        )
    )
  );
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const ip = getClientIp(req);
  const check = quoteLimit.take(`ip:${ip ?? "unknown"}`);
  if (!check.ok) {
    res.set("Retry-After", String(check.retryAfterSeconds));
    res.status(429).send({
      code: "RATE_LIMITED",
      message: "Too many requests. Please try again shortly.",
      retryAfter: check.retryAfterSeconds,
    });
    return;
  }
  try {
    const store = await getPublicStoreInventoryData(String(req.body.storeId));
    const lines = (req.body.lines as QuoteLineInput[]).map((l) => ({
      itemId: l.itemId,
      quantity: l.quantity,
      params: l.params ?? [],
    }));
    res.send(
      priceLines(store, lines, String(req.body.currency).toUpperCase(), {
        fulfilment: req.body.fulfilment as Fulfilment | undefined,
        locationProvince: ip ? resolveCaProvinceFromGeo(geoip.lookup(ip)) : null,
      })
    );
  } catch (e) {
    sendPublicError(res, e);
  }
}
