import moment from "moment-timezone";
import { StoreOrder } from "../interfaces/store";

/*
 * Store Overview numbers (progress.md L.6 / BE 1.5, WA 6.5), worked out from the store's orders.
 *
 * Definitions (shown to merchants in the same words in the webapp):
 *   - An order counts once it is **paid**, on the day it was paid (`storeOrderPaidAt`), in the
 *     merchant's time zone. Unpaid checkouts and cancelled ones never count; a fully refunded
 *     order isn't counted as an order and adds nothing to sales.
 *   - Sales = what shoppers paid (items, delivery and tax) minus refunds, per currency. Amounts
 *     in different currencies are never added together.
 *   - Average order = sales ÷ orders, per currency.
 *   - Best sellers = units sold in the last 30 days (not in fully refunded orders), top 5, with
 *     their item totals; partial refunds don't take units back (a refund isn't tied to a line).
 */
export const STATS_DAYS = 7;
export const BEST_SELLER_DAYS = 30;
export const BEST_SELLER_COUNT = 5;
/** The chart's ranges (WA overview redesign, 2026-11-22): `?days=`. */
export const RANGE_DAYS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];
export const RECENT_ORDERS = 6;
/** Paid orders still to be handed over (the webapp's Orders "To do" filter). */
export const TO_DO_STATUSES: readonly StoreOrder["storeOrderStatus"][] = ["PAID", "PREPARING", "READY", "SHIPPED"];

export type StatsOrder = Pick<
  StoreOrder,
  "storeOrderStatus" | "storeOrderPaidAt" | "storeOrderTotalMinor" | "storeOrderRefundedMinor" | "storeOrderCurrency" | "storeOrderLines"
> &
  Partial<Pick<StoreOrder, "storeOrderId" | "storeOrderCode" | "storeOrderType">>;

/** `?days=` as a range, or null when it isn't one of RANGE_DAYS. */
export function toRangeDays(v: unknown): RangeDays | null {
  const n = typeof v === "string" && /^\d{1,2}$/.test(v) ? Number(v) : NaN;
  return (RANGE_DAYS as readonly number[]).includes(n) ? (n as RangeDays) : null;
}

export interface Money {
  currency: string;
  minor: number;
}

export interface PeriodStats {
  orders: number;
  sales: Money[];
  averageOrder: Money[];
}

export interface DayStats {
  /** YYYY-MM-DD in the merchant's time zone. */
  date: string;
  orders: number;
  sales: Money[];
}

export interface BestSeller {
  itemId: string;
  itemName: string;
  quantity: number;
  sales: Money[];
  /** The item's first photo (filled in by the route; missing when it has none or is gone). */
  imageUri?: string;
}

/** A paid order for the live activity list. */
export interface RecentOrder {
  orderId: string;
  code: string;
  totalMinor: number;
  currency: string;
  type: StoreOrder["storeOrderType"] | null;
  paidAt: number;
}

/** One line of the overview's live activity list, newest first. */
export type ActivityItem =
  | ({ kind: "order"; at: number } & Omit<RecentOrder, "paidAt">)
  | { kind: "review"; at: number; rating: number; comment: string; authorName: string }
  | { kind: "message"; at: number; conversationId: string; customerName: string; preview: string };

export const ACTIVITY_COUNT = 8;

export interface StoreOverviewStats {
  tz: string;
  today: PeriodStats;
  last7: PeriodStats;
  previous7: PeriodStats;
  /** The asked range (`?days=`, 7 by default) and the same number of days before it. */
  rangeDays: number;
  current: PeriodStats;
  previous: PeriodStats;
  /** The range's days, oldest first; today is last (7 without `?days=`, as before). */
  days: DayStats[];
  /** Best sellers cover the range when `?days=` was given, else the last 30 days. */
  bestSellerDays: number;
  bestSellers: BestSeller[];
  /** Newest paid orders (within the orders read). */
  recentOrders: RecentOrder[];
  /** Paid orders not yet completed, among the orders read (the window covers at least 30 days). */
  ordersToDo: number;
  /** True if the store had more orders than were read; the numbers then cover the newest ones. */
  partial: boolean;
  generatedAt: number;
}

/** The time-zone check for `?tz=`: a real IANA zone name. */
export function isTimeZone(tz: unknown): tz is string {
  return typeof tz === "string" && tz.length <= 64 && moment.tz.zone(tz) !== null;
}

/** Where the order reads begin, in `tz`: the range and the one before it, and the best sellers' days. */
export function statsWindowStart(now: number, tz: string, rangeDays = STATS_DAYS, bestSellerDays = BEST_SELLER_DAYS): number {
  const days = Math.max(2 * rangeDays, bestSellerDays);
  return moment.tz(now, tz).startOf("day").subtract(days - 1, "days").valueOf();
}

const counts = (o: StatsOrder) =>
  typeof o.storeOrderPaidAt === "number" && o.storeOrderStatus !== "PENDING_PAYMENT" && o.storeOrderStatus !== "CANCELLED";
const fullyRefunded = (o: StatsOrder) =>
  o.storeOrderStatus === "REFUNDED" || (o.storeOrderRefundedMinor ?? 0) >= o.storeOrderTotalMinor;
const netMinor = (o: StatsOrder) => Math.max(0, o.storeOrderTotalMinor - (o.storeOrderRefundedMinor ?? 0));

class MoneyBag {
  private by = new Map<string, number>();
  add(currency: string, minor: number): void {
    this.by.set(currency, (this.by.get(currency) ?? 0) + minor);
  }
  get(currency: string): number {
    return this.by.get(currency) ?? 0;
  }
  /** Largest first, so the main currency leads. */
  list(): Money[] {
    return [...this.by.entries()].map(([currency, minor]) => ({ currency, minor })).sort((a, b) => b.minor - a.minor || a.currency.localeCompare(b.currency));
  }
}

class Period {
  orders = 0;
  sales = new MoneyBag();
  perCurrency = new Map<string, number>();
  add(o: StatsOrder): void {
    if (fullyRefunded(o)) return;
    this.orders++;
    this.sales.add(o.storeOrderCurrency, netMinor(o));
    this.perCurrency.set(o.storeOrderCurrency, (this.perCurrency.get(o.storeOrderCurrency) ?? 0) + 1);
  }
  stats(): PeriodStats {
    const sales = this.sales.list();
    return {
      orders: this.orders,
      sales,
      averageOrder: sales.map((m) => ({ currency: m.currency, minor: Math.round(m.minor / (this.perCurrency.get(m.currency) || 1)) })),
    };
  }
}

export function computeStoreOverview(
  orders: StatsOrder[],
  now: number,
  tz: string,
  partial = false,
  opts: { rangeDays?: number; bestSellerDays?: number } = {}
): StoreOverviewStats {
  const rangeDays = opts.rangeDays ?? STATS_DAYS;
  const bestSellerDays = opts.bestSellerDays ?? BEST_SELLER_DAYS;
  const today = moment.tz(now, tz).startOf("day");
  const dayKey = (ms: number) => moment.tz(ms, tz).format("YYYY-MM-DD");
  const daysBack = (n: number) => today.clone().subtract(n, "days").valueOf();

  const todayStart = today.valueOf();
  const last7Start = daysBack(STATS_DAYS - 1);
  const prev7Start = daysBack(2 * STATS_DAYS - 1);
  const rangeStart = daysBack(rangeDays - 1);
  const prevRangeStart = daysBack(2 * rangeDays - 1);
  const bestStart = daysBack(bestSellerDays - 1);

  const periods = { today: new Period(), last7: new Period(), previous7: new Period(), current: new Period(), previous: new Period() };
  const days = new Map<string, Period>();
  for (let i = rangeDays - 1; i >= 0; i--) days.set(dayKey(daysBack(i)), new Period());
  const best = new Map<string, { itemName: string; quantity: number; sales: MoneyBag; lastPaid: number }>();
  const recent: StatsOrder[] = [];
  let ordersToDo = 0;

  for (const o of orders) {
    if (!counts(o)) continue;
    const paid = o.storeOrderPaidAt!;
    if (paid > now) continue;
    if (TO_DO_STATUSES.includes(o.storeOrderStatus)) ordersToDo++;
    if (!fullyRefunded(o)) recent.push(o);
    if (paid >= todayStart) periods.today.add(o);
    if (paid >= last7Start) periods.last7.add(o);
    else if (paid >= prev7Start) periods.previous7.add(o);
    if (paid >= rangeStart) {
      periods.current.add(o);
      days.get(dayKey(paid))?.add(o);
    } else if (paid >= prevRangeStart) {
      periods.previous.add(o);
    }
    if (paid >= bestStart && !fullyRefunded(o)) {
      for (const line of o.storeOrderLines ?? []) {
        const b = best.get(line.itemId) ?? { itemName: line.itemName, quantity: 0, sales: new MoneyBag(), lastPaid: 0 };
        b.quantity += line.quantity;
        b.sales.add(o.storeOrderCurrency, line.totalMinor);
        // The name from the newest order (an item renamed later shows its new name).
        if (paid >= b.lastPaid) {
          b.itemName = line.itemName;
          b.lastPaid = paid;
        }
        best.set(line.itemId, b);
      }
    }
  }

  return {
    tz,
    today: periods.today.stats(),
    last7: periods.last7.stats(),
    previous7: periods.previous7.stats(),
    rangeDays,
    current: periods.current.stats(),
    previous: periods.previous.stats(),
    days: [...days.entries()].map(([date, p]) => ({ date, orders: p.orders, sales: p.sales.list() })),
    bestSellerDays,
    bestSellers: [...best.entries()]
      .map(([itemId, b]) => ({ itemId, itemName: b.itemName, quantity: b.quantity, sales: b.sales.list() }))
      .sort((a, b) => b.quantity - a.quantity || a.itemName.localeCompare(b.itemName))
      .slice(0, BEST_SELLER_COUNT),
    recentOrders: recent
      .sort((a, b) => b.storeOrderPaidAt! - a.storeOrderPaidAt!)
      .slice(0, RECENT_ORDERS)
      .map((o) => ({
        orderId: o.storeOrderId ?? "",
        code: o.storeOrderCode ?? "",
        totalMinor: netMinor(o),
        currency: o.storeOrderCurrency,
        type: o.storeOrderType ?? null,
        paidAt: o.storeOrderPaidAt!,
      })),
    ordersToDo,
    partial,
    generatedAt: now,
  };
}

/** The live activity list: orders, reviews and shopper messages together, newest first. */
export function buildActivity(
  orders: RecentOrder[],
  reviews: { createdAt: number; rating: number; comment: string; authorName: string }[],
  messages: { conversationId: string; lastAt: number; customerName: string; preview: string }[],
  limit = ACTIVITY_COUNT
): ActivityItem[] {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const items: ActivityItem[] = [
    ...orders.map(({ paidAt, ...o }): ActivityItem => ({ kind: "order", at: paidAt, ...o })),
    ...reviews.map((r): ActivityItem => ({ kind: "review", at: r.createdAt, rating: r.rating, comment: clip(r.comment, 120), authorName: r.authorName })),
    ...messages.map((m): ActivityItem => ({ kind: "message", at: m.lastAt, conversationId: m.conversationId, customerName: m.customerName, preview: clip(m.preview, 120) })),
  ];
  return items.sort((a, b) => b.at - a.at).slice(0, limit);
}
