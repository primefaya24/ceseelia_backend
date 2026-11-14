import { Request, Response } from "express";
import Stripe from "stripe";
import { StoreOrder } from "../core/interfaces/store";
import {
  cancelPendingOrder,
  getOrderById,
  markEventProcessed,
  markOrderPaid,
  recordOrderDispute,
  recordOrderRefund,
  wasEventProcessed,
} from "../aws/dynamodb/dynamo-entities/order";
import { updateStorePaymentsStatus } from "../aws/dynamodb/dynamo-entities/store";
import { getStripe, getStripeSecrets, PaymentsNotConfiguredError } from "./stripe";

/*
 * POST /api/v1/payments/stripe-connect-webhook (progress.md 5.5): events from the stores'
 * connected accounts (Connect Standard, direct charges). Registered in app.ts before
 * express.json() (the signature is over the raw body), signed with `webhookSecret`.
 *
 *   400 without a valid Stripe-Signature · 503 when the secret isn't set up (Stripe retries)
 *   500 when handling failed (Stripe retries) · 200 otherwise, also for events we don't use
 *
 * An event only touches an order when it comes from the order's own connected account
 * (`event.account`) and names the order's own Checkout Session or PaymentIntent, so one
 * merchant can never move another store's order. Every change is conditional (paid only from
 * PENDING_PAYMENT, and so on), so repeats and out-of-order events are harmless; processed event
 * ids are also kept (`STRIPE_EVENT#<id>`) to skip repeats early.
 *
 *   checkout.session.completed (paid) / async_payment_succeeded → PAID (5.6: stock, counters)
 *   checkout.session.expired → CANCELLED (PAYMENT_EXPIRED)
 *   checkout.session.async_payment_failed → CANCELLED (PAYMENT_FAILED)
 *   payment_intent.payment_failed → nothing: Checkout lets the shopper try another card until
 *     the session expires, which then cancels the order
 *   charge.refunded → refunded amount; a full refund makes the order REFUNDED
 *   charge.dispute.* → the dispute's status on the order
 *   account.updated → the store's cached payments flags (5.2b)
 */

const idOf = (v: unknown): string =>
  typeof v === "string" ? v : v && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : "";

/* The order a session is for, only if it's this account's and this session's. */
async function orderForSession(event: Stripe.Event, session: Stripe.Checkout.Session): Promise<StoreOrder | null> {
  const orderId = session.metadata?.orderId ?? session.client_reference_id ?? "";
  if (!orderId || session.mode !== "payment") return null;
  const order = await getOrderById(orderId);
  if (!order) return null;
  if (order.storeOrderStripe.accountId !== event.account || order.storeOrderStripe.checkoutSessionId !== session.id) {
    console.warn(`[connect webhook] ${event.id}: session ${session.id} doesn't match order ${orderId}`);
    return null;
  }
  return order;
}

/* The order a PaymentIntent paid for (refunds, disputes), checked the same way. */
async function orderForPaymentIntent(event: Stripe.Event, paymentIntentId: string): Promise<StoreOrder | null> {
  if (!paymentIntentId || !event.account) return null;
  const stripe = await getStripe();
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {}, { stripeAccount: event.account });
  const order = pi.metadata?.orderId ? await getOrderById(pi.metadata.orderId) : null;
  if (!order) return null;
  if (order.storeOrderStripe.accountId !== event.account || order.storeOrderStripe.paymentIntentId !== paymentIntentId) {
    console.warn(`[connect webhook] ${event.id}: payment ${paymentIntentId} doesn't match order ${order.storeOrderId}`);
    return null;
  }
  return order;
}

export async function handleConnectEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      // A delayed method (bank debit) completes unpaid; async_payment_succeeded follows.
      if (session.payment_status !== "paid") return;
      const order = await orderForSession(event, session);
      if (!order) return;
      const result = await markOrderPaid(order, idOf(session.payment_intent));
      if (result === "PAID_SHORT") {
        console.warn(`[connect webhook] order ${order.storeOrderId} paid but short of stock: the merchant must refund or restock`);
      }
      return;
    }
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed": {
      const order = await orderForSession(event, event.data.object as Stripe.Checkout.Session);
      if (order) {
        await cancelPendingOrder(order, event.type === "checkout.session.expired" ? "PAYMENT_EXPIRED" : "PAYMENT_FAILED");
      }
      return;
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const order = await orderForPaymentIntent(event, idOf(charge.payment_intent));
      if (order) await recordOrderRefund(order, charge.amount_refunded, charge.refunded === true);
      return;
    }
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed": {
      const dispute = event.data.object as Stripe.Dispute;
      const order = await orderForPaymentIntent(event, idOf(dispute.payment_intent));
      if (order) await recordOrderDispute(order, dispute.status, dispute.amount);
      return;
    }
    case "account.updated": {
      const account = event.data.object as Stripe.Account;
      const storeId = account.metadata?.storeId;
      if (!storeId || account.id !== event.account) return;
      // Only while the store still uses this account (the update is conditional on it).
      await updateStorePaymentsStatus(storeId, account.id, {
        chargesEnabled: account.charges_enabled === true,
        payoutsEnabled: account.payouts_enabled === true,
        detailsSubmitted: account.details_submitted === true,
      });
      return;
    }
    default:
      return;
  }
}

export async function handleConnectWebhook(req: Request, res: Response): Promise<void> {
  let event: Stripe.Event;
  try {
    const { webhookSecret } = await getStripeSecrets();
    if (!webhookSecret) throw new PaymentsNotConfiguredError("webhookSecret is not set");
    const signature = req.header("stripe-signature");
    if (!signature || !Buffer.isBuffer(req.body)) {
      res.status(400).send({ code: "BAD_SIGNATURE" });
      return;
    }
    const stripe = await getStripe();
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
    } catch {
      res.status(400).send({ code: "BAD_SIGNATURE" });
      return;
    }
  } catch (e) {
    console.error("[connect webhook]", (e as Error).message);
    res.status(503).send({ code: "PAYMENTS_NOT_CONFIGURED" });
    return;
  }

  // The platform's own events (subscriptions) go to the Billing endpoint.
  if (!event.account) {
    res.send({ received: true });
    return;
  }
  try {
    if (await wasEventProcessed(event.id)) {
      res.send({ received: true, duplicate: true });
      return;
    }
    await handleConnectEvent(event);
    await markEventProcessed(event.id, event.type);
    res.send({ received: true });
  } catch (e) {
    console.error(`[connect webhook] ${event.type} ${event.id} failed`, e);
    res.status(500).send({ code: "WEBHOOK_FAILED" });
  }
}
