import moment from "moment-timezone";
import { StoreOrder } from "../interfaces/store";

/*
 * Commission reporting (progress.md L.8 / 8.4): per store, for one calendar month in the
 * admin's time zone, from the fee saved on each order (`storeOrderPlatformFeeMinor`, exactly the
 * `application_fee_amount` sent to Stripe). The fee is kept on refunds
 * (`refund_application_fee: false`), so a refunded order still earned it. Per currency, never
 * added across currencies. `reconcile` compares with Stripe's own list of application fees.
 */
export interface Money {
  currency: string;
  minor: number;
}

export type CommissionOrder = Pick<
  StoreOrder,
  "storeOrderStatus" | "storeOrderPaidAt" | "storeOrderTotalMinor" | "storeOrderRefundedMinor" | "storeOrderCurrency" | "storeOrderPlatformFeeMinor"
>;

export interface CommissionRow {
  storeId: string;
  storeName: string;
  plan: string;
  orders: number;
  /** What shoppers paid, before refunds. */
  sales: Money[];
  refunds: Money[];
  commission: Money[];
  stripe?: StripeFeeSum;
  /** With `stripe`: the same number of fees and the same amounts per currency. */
  matches?: boolean;
}

export interface StripeFeeSum {
  count: number;
  fees: Money[];
  /** Fees Stripe gave back (not done by Ceseelia; disputes or manual refunds of the fee). */
  refunded: Money[];
}

class Bag {
  private by = new Map<string, number>();
  add(c: string, minor: number): void {
    if (minor) this.by.set(c, (this.by.get(c) ?? 0) + minor);
  }
  get(c: string): number {
    return this.by.get(c) ?? 0;
  }
  list(): Money[] {
    return [...this.by.entries()].map(([currency, minor]) => ({ currency, minor })).sort((a, b) => a.currency.localeCompare(b.currency));
  }
}

/** A month like 2026-11, from 2024-01 to this month. */
export function isReportMonth(m: unknown, now = Date.now()): m is string {
  if (typeof m !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return false;
  return m >= "2024-01" && m <= moment.utc(now).add(1, "day").format("YYYY-MM");
}

export function monthRange(month: string, tz: string): { start: number; end: number } {
  const start = moment.tz(`${month}-01`, "YYYY-MM-DD", tz).startOf("day");
  return { start: start.valueOf(), end: start.clone().add(1, "month").valueOf() };
}

const paidIn = (o: CommissionOrder, start: number, end: number) =>
  typeof o.storeOrderPaidAt === "number" &&
  o.storeOrderPaidAt >= start &&
  o.storeOrderPaidAt < end &&
  o.storeOrderStatus !== "PENDING_PAYMENT" &&
  o.storeOrderStatus !== "CANCELLED";

export function commissionRow(store: { storeId: string; storeName: string; plan: string }, orders: CommissionOrder[], start: number, end: number): CommissionRow {
  const sales = new Bag();
  const refunds = new Bag();
  const commission = new Bag();
  let n = 0;
  for (const o of orders) {
    if (!paidIn(o, start, end)) continue;
    n++;
    sales.add(o.storeOrderCurrency, o.storeOrderTotalMinor);
    refunds.add(o.storeOrderCurrency, Math.min(o.storeOrderTotalMinor, o.storeOrderRefundedMinor ?? 0));
    commission.add(o.storeOrderCurrency, Math.max(0, o.storeOrderPlatformFeeMinor ?? 0));
  }
  return { ...store, orders: n, sales: sales.list(), refunds: refunds.list(), commission: commission.list() };
}

export function totalsOf(rows: CommissionRow[]): { orders: number; sales: Money[]; refunds: Money[]; commission: Money[] } {
  const sales = new Bag();
  const refunds = new Bag();
  const commission = new Bag();
  let orders = 0;
  for (const r of rows) {
    orders += r.orders;
    r.sales.forEach((m) => sales.add(m.currency, m.minor));
    r.refunds.forEach((m) => refunds.add(m.currency, m.minor));
    r.commission.forEach((m) => commission.add(m.currency, m.minor));
  }
  return { orders, sales: sales.list(), refunds: refunds.list(), commission: commission.list() };
}

export interface StripeFee {
  account: string;
  currency: string;
  amount: number;
  amountRefunded: number;
}

/** Stripe's fees grouped by connected account. */
export function sumStripeFees(fees: StripeFee[]): Map<string, StripeFeeSum> {
  const by = new Map<string, { count: number; fees: Bag; refunded: Bag }>();
  for (const f of fees) {
    const g = by.get(f.account) ?? { count: 0, fees: new Bag(), refunded: new Bag() };
    g.count++;
    g.fees.add(f.currency.toUpperCase(), f.amount);
    g.refunded.add(f.currency.toUpperCase(), f.amountRefunded);
    by.set(f.account, g);
  }
  return new Map([...by.entries()].map(([k, g]) => [k, { count: g.count, fees: g.fees.list(), refunded: g.refunded.list() }]));
}

const sameMoney = (a: Money[], b: Money[]) => a.length === b.length && a.every((m, i) => m.currency === b[i].currency && m.minor === b[i].minor);

/** Our numbers against Stripe's: an order with a fee is one Stripe fee. */
export function reconcileRow(row: CommissionRow, stripe: StripeFeeSum | undefined, feeOrders: number): CommissionRow {
  const s = stripe ?? { count: 0, fees: [], refunded: [] };
  return { ...row, stripe: s, matches: s.count === feeOrders && sameMoney(s.fees, row.commission) };
}

/** Comma-separated, one row per store and currency; cells starting = + - @ are made plain text. */
export function commissionCsv(month: string, rows: CommissionRow[]): string {
  const cell = (v: string | number) => {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const amt = (list: Money[], c: string) => ((list.find((m) => m.currency === c)?.minor ?? 0) / 100).toFixed(2);
  const lines = [["Month", "Store", "Store ID", "Plan", "Currency", "Store orders (all currencies)", "Sales", "Refunds", "Commission"].join(",")];
  for (const r of rows) {
    const currencies = [...new Set([...r.sales, ...r.commission].map((m) => m.currency))];
    for (const c of currencies.length ? currencies : []) {
      lines.push([month, r.storeName, r.storeId, r.plan, c, r.orders, amt(r.sales, c), amt(r.refunds, c), amt(r.commission, c)].map(cell).join(","));
    }
  }
  return lines.join("\n") + "\n";
}
