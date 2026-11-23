import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { listStatsOrders } from "../../../../layers/aws/dynamodb/dynamo-entities/order";
import { listStoreItems } from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { listReviews } from "../../../../layers/aws/dynamodb/dynamo-entities/review";
import { countUnreadConversations, listConversations } from "../../../../layers/aws/dynamodb/dynamo-entities/conversation";
import {
  ActivityItem,
  buildActivity,
  computeStoreOverview,
  isTimeZone,
  statsWindowStart,
  StoreOverviewStats,
  toRangeDays,
} from "../../../../layers/core/store-stats";
import { getCachedOverview, OVERVIEW_CACHE_MS, resetOverviewCache, setCachedOverview } from "../../../../layers/core/store-stats/overview-cache";
import { log } from "../../../../layers/core/logger";

/*
 * GET /store/overview/:storeId?tz=<IANA zone>&days=7|30|90 (store members, progress.md L.6 / BE 1.5,
 * WA 6.5; range, activity and attention added with the overview redesign, 2026-11-22)
 *   → 200 StoreOverviewResponse: today, the last 7 days and the 7 before (kept for older webapps),
 *     the asked range and the one before it (`current` / `previous`), a day-by-day series for the
 *     range, best sellers (the range, or 30 days without `days`) with their first photo, the
 *     newest activity (paid orders, reviews, shopper messages) and what needs the merchant.
 *
 * `tz` is the browser's zone (days start at the merchant's midnight); a missing or unknown zone
 * falls back to UTC. Read from the store's orders (created up to a day before the window, since
 * an order is counted on the day it was paid). Answers are kept 15 s per store, zone and range,
 * and forgotten when an order is paid. The extras (photos, reviews, messages) never fail the
 * answer: each one that can't be read is simply left out.
 */
export { OVERVIEW_CACHE_MS };
export const resetOverviewCacheForTests = (): void => resetOverviewCache();
export const REVIEWS_READ = 20;
export const CONVERSATIONS_READ = 5;

export interface StoreOverviewResponse extends StoreOverviewStats {
  activity: ActivityItem[];
  attention: { ordersToDo: number; unreadMessages: number; reviewsToReply: number };
}

export default function registerRoute(router: Router): void {
  router.get("/overview/:storeId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) =>
        (req.query.tz === undefined || typeof req.query.tz === "string") &&
        (req.query.days === undefined || typeof req.query.days === "string"),
      (req) => req.query.days === undefined || toRangeDays(req.query.days) !== null,
      executeRouteCore,
      true,
      storeMember((req) => req.params.storeId)
    );
  });
}

/** Run a read that may fail without failing the overview. */
async function quiet<T>(what: string, storeId: string, fallback: T, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    log.warn({ err: e, storeId }, `store/overview: couldn't read ${what}`);
    return fallback;
  }
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const storeId = String(req.params.storeId);
  const tz = isTimeZone(req.query.tz) ? req.query.tz : "UTC";
  const days = toRangeDays(req.query.days);
  const now = Date.now();
  const hit = getCachedOverview<StoreOverviewResponse>(storeId, tz, days, now);
  if (hit) {
    res.send(hit);
    return;
  }
  try {
    const rangeDays = days ?? undefined;
    const bestSellerDays = days ?? undefined;
    const from = statsWindowStart(now, tz, rangeDays, bestSellerDays) - 24 * 3600 * 1000;
    const [{ orders, partial }, items, reviews, conversations, unreadMessages] = await Promise.all([
      listStatsOrders(storeId, from),
      quiet("items", storeId, [], () => listStoreItems(storeId)),
      quiet("reviews", storeId, [], async () => (await listReviews(storeId, { publishedOnly: true, limit: REVIEWS_READ })).reviews),
      quiet("conversations", storeId, [], async () => (await listConversations(storeId, { limit: CONVERSATIONS_READ })).conversations),
      quiet("unread messages", storeId, 0, () => countUnreadConversations(storeId)),
    ]);
    const stats = computeStoreOverview(orders, now, tz, partial, { rangeDays, bestSellerDays });

    const photo = new Map<string, string>();
    for (const it of items) {
      const uri = it?.storeItemImageUris?.[0];
      if (it?.storeItemId && typeof uri === "string" && uri) photo.set(String(it.storeItemId), uri);
    }
    const okReviews = reviews.filter((r) => r && typeof r.createdAt === "number");
    const shopperMessages = conversations.filter((c) => c && c.lastFrom === "CUSTOMER" && typeof c.lastAt === "number");

    const body: StoreOverviewResponse = {
      ...stats,
      bestSellers: stats.bestSellers.map((b) => (photo.has(b.itemId) ? { ...b, imageUri: photo.get(b.itemId) } : b)),
      activity: buildActivity(stats.recentOrders, okReviews, shopperMessages),
      attention: {
        ordersToDo: stats.ordersToDo,
        unreadMessages: typeof unreadMessages === "number" ? unreadMessages : 0,
        reviewsToReply: okReviews.filter((r) => !r.reply).length,
      },
    };
    setCachedOverview(storeId, tz, days, body, now);
    res.send(body);
  } catch (e) {
    log.error({ err: e, storeId }, "In store/overview");
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
