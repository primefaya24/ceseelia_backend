import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { appConstants } from "../../../../constants";
import { StoreOverview } from "../../../../layers/core/interfaces/store";
import { getAllStores } from "../../../../layers/aws/dynamodb/dynamo-entities/admin";
import { getStoreSummaries } from "../../../../layers/aws/dynamodb/dynamo-entities/store-admin";
import { log } from "../../../../layers/core/logger";

/*
 * GET /admin/get-all-stores?q=&limit=&cursor=  (admins; L.9 paging)
 * → { stores, next, total }: the store overview rows (small, all read), matching `q` (name or
 * slug, any case), most recent order first then name; `limit` (1–100, default 50) from `cursor`
 * (the `next` of the page before). Only the page's stores get their status, plan and billing
 * (P.8) from SETTINGS, and only those fields. Never Stripe ids.
 */
export const STORES_PAGE = 50;

export default function registerRoute(router: Router): void {
  router.get("/get-all-stores", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (r) => ["q", "limit", "cursor"].every((k) => r.query[k] === undefined || typeof r.query[k] === "string"),
      (r) =>
        (r.query.q === undefined || String(r.query.q).length <= 100) &&
        (r.query.limit === undefined || /^\d{1,3}$/.test(String(r.query.limit))) &&
        (r.query.cursor === undefined || /^\d{1,7}$/.test(String(r.query.cursor))),
      executeRouteCore,
      true,
      true
    );
  });
}

export function matchStores(stores: StoreOverview[], q: string): StoreOverview[] {
  const needle = q.trim().toLowerCase();
  const found = needle
    ? stores.filter((s) => `${s.storeName ?? ""} ${s.storeSlug ?? ""}`.toLowerCase().includes(needle))
    : stores.slice();
  return found.sort(
    (a, b) =>
      (b.storeOrderLastCompletedTimestamp ?? 0) - (a.storeOrderLastCompletedTimestamp ?? 0) ||
      String(a.storeName ?? "").localeCompare(String(b.storeName ?? "")) ||
      String(a.storeId).localeCompare(String(b.storeId))
  );
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? STORES_PAGE)));
    const from = Number(req.query.cursor ?? 0);
    const found = matchStores(await getAllStores(), String(req.query.q ?? ""));
    const page = found.slice(from, from + limit);
    const summaries = await getStoreSummaries(page.map((s) => String(s.storeId)));
    const stores = page.map((s) => {
      const sum = summaries[String(s.storeId)];
      if (!sum) return s;
      const { stripeAccountId: _stripe, ...shown } = sum;
      return { ...s, ...shown };
    });
    res.send({ stores, next: from + limit < found.length ? String(from + limit) : null, total: found.length });
  } catch (e) {
    log.error({ err: e }, "In admin/get-all-stores");
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
