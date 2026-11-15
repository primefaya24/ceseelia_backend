import Stripe from "stripe";
import {
  cancelPendingOrder,
  deletePendingOrderRow,
  getOrderById,
  listStalePendingOrders,
  markOrderPaid,
} from "../aws/dynamodb/dynamo-entities/order";
import { ORDER_CHECKOUT_LIFETIME_S } from "./order-checkout";
import { getStripe } from "./stripe";
import { notifyOrderPaid } from "../notifications/order-emails";
import { log } from "../core/logger";

/*
 * The lost-order sweeper (progress.md 5.7), every SERVER_WATCH_CHECK_FOR_LOST_ORDERS_INTERVAL
 * (index.ts). A fallback for Connect webhook events that never arrived: create-order lists every
 * order under APP_PENDING_ORDER, and once its Checkout Session should have ended (lifetime +
 * SWEEP_MARGIN_MS), the sweeper asks Stripe what really happened:
 *
 *   order gone, or no longer PENDING_PAYMENT     → just drop the row (the webhook did its job)
 *   session expired, or missing on the account   → CANCELLED (PAYMENT_EXPIRED)
 *   session still open past its expiry           → expire it, then CANCELLED (PAYMENT_EXPIRED)
 *   session complete and paid                    → PAID (`markOrderPaid`: stock, counters), a
 *                                                   missed webhook, logged
 *   complete but unpaid (a bank debit on its way) → its PaymentIntent: succeeded → PAID;
 *                                                   canceled / needs a new method → CANCELLED
 *                                                   (PAYMENT_FAILED); still processing → kept
 *
 * Every change is the same conditional write the webhook makes, so a webhook arriving at the
 * same moment is harmless. A row whose check fails (Stripe down) stays for the next run.
 */
export const SWEEP_MARGIN_MS = 15 * 60 * 1000;
export const SWEEP_BATCH = 200;

export interface SweepResult {
  checked: number;
  paid: number;
  cancelled: number;
  cleared: number;
  kept: number;
  failed: number;
}

type Outcome = "paid" | "cancelled" | "cleared" | "kept";

const idOf = (v: unknown): string =>
  typeof v === "string" ? v : v && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : "";

const isMissing = (e: unknown) => (e as { code?: string })?.code === "resource_missing";

async function settle(orderId: string, stripe: Stripe): Promise<Outcome> {
  const order = await getOrderById(orderId);
  if (!order || order.storeOrderStatus !== "PENDING_PAYMENT") return "cleared";
  const { accountId, checkoutSessionId } = order.storeOrderStripe ?? { accountId: "", checkoutSessionId: "" };
  if (!accountId || !checkoutSessionId) {
    await cancelPendingOrder(order, "PAYMENT_EXPIRED");
    return "cancelled";
  }
  const opts = { stripeAccount: accountId };

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(checkoutSessionId, {}, opts);
  } catch (e) {
    // The merchant disconnected the account, or the session is gone: nobody can pay it.
    if (!isMissing(e)) throw e;
    await cancelPendingOrder(order, "PAYMENT_EXPIRED");
    return "cancelled";
  }

  if (session.status === "open") {
    try {
      session = await stripe.checkout.sessions.expire(checkoutSessionId, {}, opts);
    } catch {
      return "kept"; // completed in the meantime, most likely; the next run sees it
    }
  }
  if (session.status === "expired") {
    await cancelPendingOrder(order, "PAYMENT_EXPIRED");
    return "cancelled";
  }
  if (session.status !== "complete") return "kept";

  const paymentIntentId = idOf(session.payment_intent);
  if (session.payment_status === "paid") {
    log.warn(`[order sweep] order ${orderId} was paid but its webhook never came; marking it paid`);
    if ((await markOrderPaid(order, paymentIntentId)) !== "ALREADY") await notifyOrderPaid(orderId);
    return "paid";
  }
  if (!paymentIntentId) return "kept";
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {}, opts);
  if (pi.status === "succeeded") {
    log.warn(`[order sweep] order ${orderId}: delayed payment succeeded without a webhook; marking it paid`);
    if ((await markOrderPaid(order, paymentIntentId)) !== "ALREADY") await notifyOrderPaid(orderId);
    return "paid";
  }
  if (pi.status === "canceled" || pi.status === "requires_payment_method") {
    await cancelPendingOrder(order, "PAYMENT_FAILED");
    return "cancelled";
  }
  return "kept";
}

export async function sweepLostOrders(now: () => number = Date.now): Promise<SweepResult> {
  const result: SweepResult = { checked: 0, paid: 0, cancelled: 0, cleared: 0, kept: 0, failed: 0 };
  const before = now() - ORDER_CHECKOUT_LIFETIME_S * 1000 - SWEEP_MARGIN_MS;
  const rows = await listStalePendingOrders(before, SWEEP_BATCH);
  if (rows.length === 0) return result;
  const stripe = await getStripe();
  for (const row of rows) {
    result.checked++;
    try {
      const outcome = await settle(row.orderId, stripe);
      result[outcome]++;
      if (outcome !== "kept") await deletePendingOrderRow(row.sk);
    } catch (e) {
      result.failed++;
      log.error({ err: e }, `[order sweep] order ${row.orderId} (store ${row.storeId}) couldn't be checked`);
    }
  }
  return result;
}
