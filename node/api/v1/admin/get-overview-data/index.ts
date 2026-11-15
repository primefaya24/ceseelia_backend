import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { appConstants } from "../../../../constants";
import { AdminOverviewData } from "../../../../layers/core/interfaces/admin";
import { StoreOverview } from "../../../../layers/core/interfaces/store";
import { isTimeZone } from "../../../../layers/core/store-stats";
import { AdminStoreInput, adminStatsWindowStart, computeAdminOverview, mapLimit } from "../../../../layers/core/admin-stats";
import { getAllStores } from "../../../../layers/aws/dynamodb/dynamo-entities/admin";
import { getStoreSummaries, listReviewQueue } from "../../../../layers/aws/dynamodb/dynamo-entities/store-admin";
import { listStatsOrders } from "../../../../layers/aws/dynamodb/dynamo-entities/order";
import { listStoreMemberIds } from "../../../../layers/aws/dynamodb/dynamo-entities/membership";
import { listItemReviewQueue } from "../../../../layers/aws/dynamodb/dynamo-entities/item-review";
import { listReviewReports } from "../../../../layers/aws/dynamodb/dynamo-entities/review";
import { countOpenTickets } from "../../../../layers/aws/dynamodb/dynamo-entities/support-ticket";
import { log } from "../../../../layers/core/logger";

/*
 * GET /admin/get-overview-data?tz=<IANA>  (admins; L.8 / 8.1) → { stats, allStores }
 * `stats` (`layers/core/admin-stats`): stores by status, merchants (people in at least one store),
 * plans, past-due subscriptions, the last 30 days against the 30 before (paid orders, sales,
 * commission), a day-by-day chart, the top 5 stores, and the admin to-do counts. Reads each
 * store's orders of the last 60 days (at most 3,000 a store; `partial` says when a store had
 * more), 8 stores at a time. Cached 60 s per time zone.
 */
const cache = new Map<string, { at: number; body: AdminOverviewData }>();
export const resetAdminOverviewCacheForTests = () => cache.clear();

export default function registerRoute(router: Router): void {
  router.get("/get-overview-data", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (r) => r.query.tz === undefined || typeof r.query.tz === "string",
      (r) => r.query.tz === undefined || isTimeZone(r.query.tz),
      executeRouteCore,
      true,
      true
    );
  });
}

async function build(tz: string): Promise<AdminOverviewData> {
  const now = Date.now();
  const allStores: StoreOverview[] = await getAllStores();
  const ids = allStores.map((s) => String(s.storeId));
  const [summaries, storeReviews, itemReviews, reviewReports, openTickets] = await Promise.all([
    getStoreSummaries(ids),
    listReviewQueue(),
    listItemReviewQueue(),
    listReviewReports(),
    countOpenTickets(),
  ]);
  const from = adminStatsWindowStart(now, tz);
  let partial = false;
  const members = new Set<string>();
  const inputs: AdminStoreInput[] = await mapLimit(allStores, 8, async (s) => {
    const id = String(s.storeId);
    const [read, memberIds] = await Promise.all([listStatsOrders(id, from), listStoreMemberIds(id)]);
    if (read.partial) partial = true;
    memberIds.forEach((m) => members.add(m));
    const sum = summaries[id];
    return {
      storeId: id,
      storeName: String(s.storeName ?? ""),
      status: sum?.status ?? "DRAFT",
      suspended: sum?.suspended === true,
      plan: String(sum?.plan ?? "NONE"),
      subscriptionStatus: sum?.subscription?.status ?? null,
      orders: read.orders,
    };
  });
  const stats = computeAdminOverview(
    inputs,
    {
      merchants: members.size,
      queues: { storeReviews: storeReviews.length, itemReviews: itemReviews.length, reviewReports: reviewReports.length, openTickets },
      partial,
    },
    now,
    tz
  );
  return { stats, allStores };
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const tz = String(req.query.tz ?? "UTC");
  try {
    const hit = cache.get(tz);
    if (hit && Date.now() - hit.at < 60_000) {
      res.send(hit.body);
      return;
    }
    const body = await build(tz);
    cache.set(tz, { at: Date.now(), body });
    res.send(body);
  } catch (e) {
    log.error({ err: e }, "In admin/get-overview-data");
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
