import { Request, Response, Router } from "express";
import Stripe from "stripe";
import { appConstants } from "../../../../constants";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { isTimeZone } from "../../../../layers/core/store-stats";
import { mapLimit } from "../../../../layers/core/admin-stats";
import {
  CommissionRow,
  StripeFee,
  commissionCsv,
  commissionRow,
  isReportMonth,
  monthRange,
  reconcileRow,
  sumStripeFees,
  totalsOf,
} from "../../../../layers/core/commission";
import { getAllStores } from "../../../../layers/aws/dynamodb/dynamo-entities/admin";
import { getStoreSummaries } from "../../../../layers/aws/dynamodb/dynamo-entities/store-admin";
import { listStatsOrders } from "../../../../layers/aws/dynamodb/dynamo-entities/order";
import { getStripe, PaymentsNotConfiguredError } from "../../../../layers/payments/stripe";
import { log } from "../../../../layers/core/logger";

/*
 * GET /admin/commission-report?month=YYYY-MM&tz=<IANA>[&reconcile=1][&format=csv]  (admins; L.8 / 8.4)
 * → { month, tz, rows: CommissionRow[] (stores with orders that month), totals, partial,
 *     unmatchedStripe?: [{ account, count, fees }] (fees on accounts no store has) }
 * `reconcile=1` also lists Stripe's application fees created that month (on the platform
 * account) and marks each store matches / doesn't. A fee near midnight on the last day can land
 * in the next month on one side (Stripe dates the charge, we date the payment webhook).
 * `format=csv` downloads the rows. Cached 60 s per query.
 */
const ORDER_CAP = 10_000;
const STRIPE_FEE_CAP = 20_000;
const cache = new Map<string, { at: number; body: unknown }>();
export const resetCommissionCacheForTests = () => cache.clear();

export default function registerRoute(router: Router): void {
  router.get("/commission-report", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (r) => typeof r.query.month === "string" && (r.query.tz === undefined || typeof r.query.tz === "string"),
      (r) => isReportMonth(r.query.month) && (r.query.tz === undefined || isTimeZone(r.query.tz)),
      executeRouteCore,
      true,
      true
    );
  });
}

async function stripeFees(start: number, end: number): Promise<{ fees: StripeFee[]; partial: boolean }> {
  const stripe = await getStripe();
  const fees: StripeFee[] = [];
  for await (const f of stripe.applicationFees.list({ created: { gte: Math.floor(start / 1000), lt: Math.floor(end / 1000) }, limit: 100 })) {
    fees.push({
      account: typeof f.account === "string" ? f.account : f.account.id,
      currency: f.currency,
      amount: f.amount,
      amountRefunded: f.amount_refunded,
    });
    if (fees.length >= STRIPE_FEE_CAP) return { fees, partial: true };
  }
  return { fees, partial: false };
}

async function build(month: string, tz: string, reconcile: boolean) {
  const { start, end } = monthRange(month, tz);
  const stores = await getAllStores();
  const summaries = await getStoreSummaries(stores.map((s) => String(s.storeId)));
  let partial = false;
  // An order is created up to 30 min before it's paid: read from a day early.
  const results = await mapLimit(stores, 8, async (s) => {
    const read = await listStatsOrders(String(s.storeId), start - 24 * 3600_000, ORDER_CAP, end);
    if (read.partial) partial = true;
    const sum = summaries[String(s.storeId)];
    const row = commissionRow({ storeId: String(s.storeId), storeName: String(s.storeName ?? ""), plan: String(sum?.plan ?? "") }, read.orders, start, end);
    const feeOrders = read.orders.filter(
      (o) => typeof o.storeOrderPaidAt === "number" && o.storeOrderPaidAt >= start && o.storeOrderPaidAt < end && (o.storeOrderPlatformFeeMinor ?? 0) > 0
    ).length;
    return { row, feeOrders, account: sum?.stripeAccountId ?? "" };
  });

  let rows: CommissionRow[] = results.map((r) => r.row);
  let unmatchedStripe: { account: string; count: number; fees: { currency: string; minor: number }[] }[] | undefined;
  let stripePartial = false;
  if (reconcile) {
    const got = await stripeFees(start, end);
    stripePartial = got.partial;
    const byAccount = sumStripeFees(got.fees);
    rows = results.map((r) => {
      const s = r.account ? byAccount.get(r.account) : undefined;
      if (r.account) byAccount.delete(r.account);
      return reconcileRow(r.row, s, r.feeOrders);
    });
    unmatchedStripe = [...byAccount.entries()].map(([account, s]) => ({ account, count: s.count, fees: s.fees }));
  }
  rows = rows.filter((r) => r.orders > 0 || (r.stripe?.count ?? 0) > 0).sort((a, b) => (b.commission[0]?.minor ?? 0) - (a.commission[0]?.minor ?? 0) || a.storeName.localeCompare(b.storeName));
  return {
    month,
    tz,
    start,
    end,
    rows,
    totals: totalsOf(rows),
    partial: partial || stripePartial,
    ...(unmatchedStripe ? { unmatchedStripe } : {}),
    generatedAt: Date.now(),
  };
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const month = String(req.query.month);
  const tz = String(req.query.tz ?? "UTC");
  const reconcile = req.query.reconcile === "1";
  const key = `${month}|${tz}|${reconcile}`;
  try {
    const hit = cache.get(key);
    const body = hit && Date.now() - hit.at < 60_000 ? hit.body : await build(month, tz, reconcile);
    if (!hit || hit.body !== body) cache.set(key, { at: Date.now(), body });
    if (req.query.format === "csv") {
      const report = body as Awaited<ReturnType<typeof build>>;
      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", `attachment; filename="ceseelia-commission-${month}.csv"`);
      res.send(commissionCsv(month, report.rows));
      return;
    }
    res.send(body);
  } catch (e) {
    if (e instanceof PaymentsNotConfiguredError) {
      res.status(503).send({ code: "PAYMENTS_NOT_CONFIGURED", message: "Stripe isn't set up, so the report can't be checked against it." });
      return;
    }
    if (e instanceof Stripe.errors.StripeError) {
      log.error({ err: e }, "In admin/commission-report: Stripe");
      res.status(502).send({ code: "STRIPE_ERROR", message: "Stripe didn't answer. Try again, or turn off the Stripe check." });
      return;
    }
    log.error({ err: e }, "In admin/commission-report");
    res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}

