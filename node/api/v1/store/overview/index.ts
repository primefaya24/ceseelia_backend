import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { listStatsOrders } from "../../../../layers/aws/dynamodb/dynamo-entities/order";
import { computeStoreOverview, isTimeZone, statsWindowStart, StoreOverviewStats } from "../../../../layers/core/store-stats";
import { log } from "../../../../layers/core/logger";

/*
 * GET /store/overview/:storeId?tz=<IANA zone> (store members, progress.md L.6 / BE 1.5, WA 6.5)
 *   → 200 StoreOverviewStats: today, the last 7 days and the 7 before (orders, sales and average
 *     order per currency), a day-by-day series, and the 30-day best sellers.
 *
 * `tz` is the browser's zone (days start at the merchant's midnight); a missing or unknown zone
 * falls back to UTC. Read from the store's orders (created up to a day before the 30-day window,
 * since an order is counted on the day it was paid); the answer is kept 30 s per store and zone.
 */
export const OVERVIEW_CACHE_MS = 30_000;
const cache = new Map<string, { at: number; body: StoreOverviewStats }>();
export const resetOverviewCacheForTests = (): void => cache.clear();

export default function registerRoute(router: Router): void {
  router.get("/overview/:storeId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => req.query.tz === undefined || typeof req.query.tz === "string",
      () => true,
      executeRouteCore,
      true,
      storeMember((req) => req.params.storeId)
    );
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const storeId = String(req.params.storeId);
  const tz = isTimeZone(req.query.tz) ? req.query.tz : "UTC";
  const now = Date.now();
  const key = `${storeId}|${tz}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < OVERVIEW_CACHE_MS) {
    res.send(hit.body);
    return;
  }
  try {
    const from = statsWindowStart(now, tz) - 24 * 3600 * 1000;
    const { orders, partial } = await listStatsOrders(storeId, from);
    const body = computeStoreOverview(orders, now, tz, partial);
    if (cache.size > 1000) cache.clear();
    cache.set(key, { at: now, body });
    res.send(body);
  } catch (e) {
    log.error({ err: e, storeId }, "In store/overview");
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
