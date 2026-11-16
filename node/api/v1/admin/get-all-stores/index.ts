import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { appConstants } from "../../../../constants";
import { StoreOverview } from "../../../../layers/core/interfaces/store";
import { getAllStores } from "../../../../layers/aws/dynamodb/dynamo-entities/admin";
import { AdminStoreSummary, getStoreSummaries } from "../../../../layers/aws/dynamodb/dynamo-entities/store-admin";
import { listItemReviewQueue } from "../../../../layers/aws/dynamodb/dynamo-entities/item-review";
import { log } from "../../../../layers/core/logger";

/*
 * GET /admin/get-all-stores?q=&filter=&limit=&cursor=  (admins; L.9 paging, UX-D filters)
 * → { stores, next, total, counts }: the store overview rows (small, all read), matching `q`
 * (name or slug, any case) and `filter` (STORE_FILTERS, default all), most recent order first
 * then name; `limit` (1–100, default 50) from `cursor` (the `next` of the page before).
 * `counts` = how many of the `q` matches each filter has (the chips). Filtering needs every
 * matching store's status, plan and billing (P.8), so those few SETTINGS fields are read for all
 * of them (one batch read per 100, as the admin overview does). Never Stripe ids.
 */
export const STORE_FILTERS = ["all", "in-review", "items", "past-due", "live", "draft", "suspended"] as const;
export type StoreFilter = (typeof STORE_FILTERS)[number];
const PAST_DUE = new Set(["past_due", "unpaid"]);

/* Whether a store belongs in a filter. Same rules as the admin overview's counts. */
export function inFilter(filter: StoreFilter, sum: AdminStoreSummary | undefined, hasHiddenItems: boolean): boolean {
  switch (filter) {
    case "all":
      return true;
    case "items":
      return hasHiddenItems;
    case "in-review":
      return sum?.status === "IN_REVIEW";
    case "past-due":
      return !!sum?.subscription && PAST_DUE.has(sum.subscription.status);
    case "live":
      return sum?.status === "LIVE" && !sum.suspended;
    case "draft":
      return !!sum && sum.status !== "LIVE" && sum.status !== "IN_REVIEW";
    case "suspended":
      return !!sum?.suspended;
  }
}
export const STORES_PAGE = 50;

export default function registerRoute(router: Router): void {
  router.get("/get-all-stores", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (r) => ["q", "filter", "limit", "cursor"].every((k) => r.query[k] === undefined || typeof r.query[k] === "string"),
      (r) =>
        (r.query.q === undefined || String(r.query.q).length <= 100) &&
        (r.query.filter === undefined || (STORE_FILTERS as readonly string[]).includes(String(r.query.filter))) &&
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
    const filter = (req.query.filter ?? "all") as StoreFilter;
    const matched = matchStores(await getAllStores(), String(req.query.q ?? ""));
    const [summaries, hiddenItems] = await Promise.all([
      getStoreSummaries(matched.map((s) => String(s.storeId))),
      listItemReviewQueue(),
    ]);
    const withHidden = new Set(hiddenItems.map((i) => i.storeId));
    const isIn = (f: StoreFilter, s: StoreOverview) => inFilter(f, summaries[String(s.storeId)], withHidden.has(String(s.storeId)));
    const counts = Object.fromEntries(STORE_FILTERS.map((f) => [f, matched.filter((s) => isIn(f, s)).length]));
    const found = matched.filter((s) => isIn(filter, s));
    const page = found.slice(from, from + limit);
    const stores = page.map((s) => {
      const sum = summaries[String(s.storeId)];
      if (!sum) return s;
      const { stripeAccountId: _stripe, ...shown } = sum;
      return { ...s, ...shown };
    });
    res.send({ stores, next: from + limit < found.length ? String(from + limit) : null, total: found.length, counts });
  } catch (e) {
    log.error({ err: e }, "In admin/get-all-stores");
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
