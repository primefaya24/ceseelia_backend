import { Request, Response } from "express";
import Stripe from "stripe";
import { getStripe, getStripeSecrets, PaymentsNotConfiguredError } from "./stripe";
import { forgetExpiredCheckout, syncSubscription } from "./subscription-sync";

/*
 * POST /api/v1/billing/stripe-webhook (progress.md P.5): the platform account's subscription
 * events. Registered in app.ts before express.json() (the signature is over the raw body).
 *
 *   400 without a valid Stripe-Signature (signed with `billingWebhookSecret`)
 *   503 when that secret isn't set up yet (Stripe keeps retrying, nothing is lost)
 *   500 when handling failed (Stripe retries); 200 otherwise, including events we don't use
 *
 * Every handled event just re-syncs the subscription it's about from Stripe, so duplicates and
 * out-of-order deliveries are harmless. Connect events (`event.account`) belong to the shopper
 * endpoint (5.4) and are ignored here.
 */

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

const idOf = (v: unknown): string | null =>
  typeof v === "string" ? v : v && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null;

/* The subscription an event is about, or null. */
export function subscriptionIdOf(event: Stripe.Event): string | null {
  const obj = event.data.object as unknown as Record<string, unknown>;
  if (SUBSCRIPTION_EVENTS.has(event.type)) return idOf(obj.id);
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    return obj.mode === "subscription" ? idOf(obj.subscription) : null;
  }
  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const parent = obj.parent as { subscription_details?: { subscription?: unknown } } | null | undefined;
    return idOf(parent?.subscription_details?.subscription);
  }
  return null;
}

export async function handleBillingWebhook(req: Request, res: Response): Promise<void> {
  let event: Stripe.Event;
  try {
    const { billingWebhookSecret } = await getStripeSecrets();
    if (!billingWebhookSecret) throw new PaymentsNotConfiguredError("billingWebhookSecret is not set");
    const signature = req.header("stripe-signature");
    if (!signature || !Buffer.isBuffer(req.body)) {
      res.status(400).send({ code: "BAD_SIGNATURE" });
      return;
    }
    const stripe = await getStripe();
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, billingWebhookSecret);
    } catch {
      res.status(400).send({ code: "BAD_SIGNATURE" });
      return;
    }
  } catch (e) {
    console.error("[billing webhook]", (e as Error).message);
    res.status(503).send({ code: "PAYMENTS_NOT_CONFIGURED" });
    return;
  }

  if (event.account) {
    res.send({ received: true });
    return;
  }

  try {
    if (event.type === "checkout.session.expired") {
      const s = event.data.object as Stripe.Checkout.Session;
      if (s.mode === "subscription") await forgetExpiredCheckout(s.metadata?.storeId, s.id);
    } else {
      const subscriptionId = subscriptionIdOf(event);
      if (subscriptionId) await syncSubscription(subscriptionId);
    }
    res.send({ received: true });
  } catch (e) {
    console.error(`[billing webhook] ${event.type} ${event.id} failed`, e);
    res.status(500).send({ code: "WEBHOOK_FAILED" });
  }
}
