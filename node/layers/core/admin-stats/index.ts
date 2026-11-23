import moment from "moment-timezone";
import { StoreOrder } from "../interfaces/store";
import { STORE_PLANS } from "../plans";

/*
 * Admin › Overview numbers (progress.md L.8 / 8.1), for the whole platform. Same definitions as
 * Store Overview (L.6, `store-stats`), so the two never disagree:
 *   - an order counts once paid, on the day it was paid, in the admin's time zone; unpaid and
 *     cancelled ones never count; a fully refunded one isn't an order and adds no sales;
 *   - sales = what shoppers paid minus refunds, per currency (never added across currencies);
 *   - commission = Ceseelia's application fee on those orders. It's kept on refunds
 *     (`refund_application_fee: false`), so a refunded order's fee still counts.
 * Periods: the last 30 days (today included) and the 30 before, for the change.
 */
export const ADMIN_STATS_DAYS = 30;
export const TOP_STORES = 5;

export const RECENT_PLATFORM_ORDERS = 8;

export type AdminStatsOrder = Pick<
  StoreOrder,
  "storeOrderStatus" | "storeOrderPaidAt" | "storeOrderTotalMinor" | "storeOrderRefundedMinor" | "storeOrderCurrency" | "storeOrderPlatformFeeMinor"
> &
  Partial<Pick<StoreOrder, "storeOrderId" | "storeOrderCode" | "storeOrderType">>;

/** A paid order anywhere on the platform, for the admin's live activity list. */
export interface PlatformRecentOrder {
  storeId: string;
  storeName: string;
  orderId: string;
  code: string;
  totalMinor: number;
  currency: string;
  commissionMinor: number;
  type: StoreOrder["storeOrderType"] | null;
  paidAt: number;
}

export interface Money {
  currency: string;
  minor: number;
}

export interface AdminStoreInput {
  storeId: string;
  storeName: string;
  status: string;
  suspended: boolean;
  plan: string;
  subscriptionStatus: string | null;
  orders: AdminStatsOrder[];
}

export interface AdminPeriod {
  orders: number;
  sales: Money[];
  commission: Money[];
}

export interface AdminOverviewStats {
  tz: string;
  stores: { total: number; live: number; draft: number; inReview: number; suspended: number };
  merchants: number;
  /** Stores with a plan (a subscription, or one an admin gave), by plan. */
  plans: Record<string, number>;
  /** Subscriptions Stripe says are past due or unpaid. */
  subscriptionsPastDue: number;
  last30: AdminPeriod;
  previous30: AdminPeriod;
  /** The asked range (`?days=`, 30 by default) and the same number of days before it. */
  rangeDays: number;
  current: AdminPeriod;
  previous: AdminPeriod;
  /** The range's days, oldest first; today is last. */
  days: { date: string; orders: number; sales: Money[]; commission: Money[] }[];
  /** Top stores over the range. */
  topStores: { storeId: string; storeName: string; orders: number; sales: Money[] }[];
  queues: { storeReviews: number; itemReviews: number; reviewReports: number; openTickets: number };
  /** Newest paid orders across all stores. */
  recentOrders: PlatformRecentOrder[];
  /** Some store had more orders than were read: its numbers cover the newest ones. */
  partial: boolean;
  generatedAt: number;
}

class Bag {
  private by = new Map<string, number>();
  add(currency: string, minor: number): void {
    if (minor) this.by.set(currency, (this.by.get(currency) ?? 0) + minor);
  }
  list(): Money[] {
    return [...this.by.entries()].map(([currency, minor]) => ({ currency, minor })).sort((a, b) => b.minor - a.minor || a.currency.localeCompare(b.currency));
  }
  /** For ranking: the biggest amount in any one currency. */
  top(): number {
    return Math.max(0, ...this.by.values());
  }
}

class Period {
  orders = 0;
  sales = new Bag();
  commission = new Bag();
  add(o: AdminStatsOrder): void {
    this.commission.add(o.storeOrderCurrency, Math.max(0, o.storeOrderPlatformFeeMinor ?? 0));
    if (fullyRefunded(o)) return;
    this.orders++;
    this.sales.add(o.storeOrderCurrency, netMinor(o));
  }
  stats(): AdminPeriod {
    return { orders: this.orders, sales: this.sales.list(), commission: this.commission.list() };
  }
}

const counts = (o: AdminStatsOrder) =>
  typeof o.storeOrderPaidAt === "number" && o.storeOrderStatus !== "PENDING_PAYMENT" && o.storeOrderStatus !== "CANCELLED";
const fullyRefunded = (o: AdminStatsOrder) =>
  o.storeOrderStatus === "REFUNDED" || (o.storeOrderRefundedMinor ?? 0) >= o.storeOrderTotalMinor;
const netMinor = (o: AdminStatsOrder) => Math.max(0, o.storeOrderTotalMinor - (o.storeOrderRefundedMinor ?? 0));

/** Where the order reads begin: the first day of the period before the range (30 days at least). */
export function adminStatsWindowStart(now: number, tz: string, rangeDays = ADMIN_STATS_DAYS): number {
  const days = 2 * Math.max(rangeDays, ADMIN_STATS_DAYS);
  return moment.tz(now, tz).startOf("day").subtract(days - 1, "days").valueOf();
}

const PAST_DUE = new Set(["past_due", "unpaid"]);

export function computeAdminOverview(
  stores: AdminStoreInput[],
  extra: { merchants: number; queues: AdminOverviewStats["queues"]; partial: boolean },
  now: number,
  tz: string,
  rangeDays = ADMIN_STATS_DAYS
): AdminOverviewStats {
  const today = moment.tz(now, tz).startOf("day");
  const dayKey = (ms: number) => moment.tz(ms, tz).format("YYYY-MM-DD");
  const back = (n: number) => today.clone().subtract(n, "days").valueOf();
  const last30Start = back(ADMIN_STATS_DAYS - 1);
  const prev30Start = back(2 * ADMIN_STATS_DAYS - 1);
  const rangeStart = back(rangeDays - 1);
  const prevRangeStart = back(2 * rangeDays - 1);

  const last30 = new Period();
  const previous30 = new Period();
  const current = new Period();
  const previous = new Period();
  const days = new Map<string, Period>();
  for (let i = rangeDays - 1; i >= 0; i--) days.set(dayKey(back(i)), new Period());
  const recent: PlatformRecentOrder[] = [];
  const perStore: { storeId: string; storeName: string; p: Period }[] = [];

  const storeCounts = { total: stores.length, live: 0, draft: 0, inReview: 0, suspended: 0 };
  const plans: Record<string, number> = Object.fromEntries(STORE_PLANS.map((p) => [p, 0]));
  let pastDue = 0;

  for (const s of stores) {
    if (s.suspended) storeCounts.suspended++;
    if (s.status === "LIVE") storeCounts.live++;
    else if (s.status === "IN_REVIEW") storeCounts.inReview++;
    else storeCounts.draft++;
    if (s.plan in plans) plans[s.plan]++;
    if (s.subscriptionStatus && PAST_DUE.has(s.subscriptionStatus)) pastDue++;

    const mine = new Period();
    for (const o of s.orders) {
      if (!counts(o)) continue;
      const paid = o.storeOrderPaidAt!;
      if (paid > now) continue;
      if (paid >= last30Start) last30.add(o);
      else if (paid >= prev30Start) previous30.add(o);
      if (paid >= rangeStart) {
        current.add(o);
        mine.add(o);
        days.get(dayKey(paid))?.add(o);
      } else if (paid >= prevRangeStart) previous.add(o);
      if (!fullyRefunded(o)) {
        recent.push({
          storeId: s.storeId,
          storeName: s.storeName,
          orderId: o.storeOrderId ?? "",
          code: o.storeOrderCode ?? "",
          totalMinor: netMinor(o),
          currency: o.storeOrderCurrency,
          commissionMinor: Math.max(0, o.storeOrderPlatformFeeMinor ?? 0),
          type: o.storeOrderType ?? null,
          paidAt: paid,
        });
      }
    }
    if (mine.orders > 0) perStore.push({ storeId: s.storeId, storeName: s.storeName, p: mine });
  }

  return {
    tz,
    stores: storeCounts,
    merchants: extra.merchants,
    plans,
    subscriptionsPastDue: pastDue,
    last30: last30.stats(),
    previous30: previous30.stats(),
    rangeDays,
    current: current.stats(),
    previous: previous.stats(),
    days: [...days.entries()].map(([date, p]) => ({ date, orders: p.orders, sales: p.sales.list(), commission: p.commission.list() })),
    topStores: perStore
      .sort((a, b) => b.p.orders - a.p.orders || b.p.sales.top() - a.p.sales.top() || a.storeName.localeCompare(b.storeName))
      .slice(0, TOP_STORES)
      .map(({ storeId, storeName, p }) => ({ storeId, storeName, orders: p.orders, sales: p.sales.list() })),
    queues: extra.queues,
    recentOrders: recent.sort((a, b) => b.paidAt - a.paidAt).slice(0, RECENT_PLATFORM_ORDERS),
    partial: extra.partial,
    generatedAt: now,
  };
}

/** Run `fn` over `items`, at most `limit` at a time, results in order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
