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

export type StatsOrder = Pick<
  StoreOrder,
  "storeOrderStatus" | "storeOrderPaidAt" | "storeOrderTotalMinor" | "storeOrderRefundedMinor" | "storeOrderCurrency" | "storeOrderLines"
>;

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
}

export interface StoreOverviewStats {
  tz: string;
  today: PeriodStats;
  last7: PeriodStats;
  previous7: PeriodStats;
  /** The last 7 days, oldest first; today is last. */
  days: DayStats[];
  bestSellers: BestSeller[];
  /** True if the store had more orders than were read; the numbers then cover the newest ones. */
  partial: boolean;
  generatedAt: number;
}

/** The time-zone check for `?tz=`: a real IANA zone name. */
export function isTimeZone(tz: unknown): tz is string {
  return typeof tz === "string" && tz.length <= 64 && moment.tz.zone(tz) !== null;
}

/** Where the order reads begin: the first day best sellers cover, in `tz`. */
export function statsWindowStart(now: number, tz: string): number {
  return moment.tz(now, tz).startOf("day").subtract(BEST_SELLER_DAYS - 1, "days").valueOf();
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

export function computeStoreOverview(orders: StatsOrder[], now: number, tz: string, partial = false): StoreOverviewStats {
  const today = moment.tz(now, tz).startOf("day");
  const dayKey = (ms: number) => moment.tz(ms, tz).format("YYYY-MM-DD");
  const daysBack = (n: number) => today.clone().subtract(n, "days").valueOf();

  const todayStart = today.valueOf();
  const last7Start = daysBack(STATS_DAYS - 1);
  const prev7Start = daysBack(2 * STATS_DAYS - 1);
  const bestStart = daysBack(BEST_SELLER_DAYS - 1);

  const periods = { today: new Period(), last7: new Period(), previous7: new Period() };
  const days = new Map<string, Period>();
  for (let i = STATS_DAYS - 1; i >= 0; i--) days.set(dayKey(daysBack(i)), new Period());
  const best = new Map<string, { itemName: string; quantity: number; sales: MoneyBag; lastPaid: number }>();

  for (const o of orders) {
    if (!counts(o)) continue;
    const paid = o.storeOrderPaidAt!;
    if (paid > now) continue;
    if (paid >= todayStart) periods.today.add(o);
    if (paid >= last7Start) {
      periods.last7.add(o);
      days.get(dayKey(paid))?.add(o);
    } else if (paid >= prev7Start) {
      periods.previous7.add(o);
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
    days: [...days.entries()].map(([date, p]) => ({ date, orders: p.orders, sales: p.sales.list() })),
    bestSellers: [...best.entries()]
      .map(([itemId, b]) => ({ itemId, itemName: b.itemName, quantity: b.quantity, sales: b.sales.list() }))
      .sort((a, b) => b.quantity - a.quantity || a.itemName.localeCompare(b.itemName))
      .slice(0, BEST_SELLER_COUNT),
    partial,
    generatedAt: now,
  };
}
