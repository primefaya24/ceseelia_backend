import Stripe from "stripe";
import { WEBAPP_URL } from "../../config";
import { PLANS, planFromLookupKey, planPriceLookupKey, StorePlan } from "../core/plans";
import { SubscriptionSnapshot } from "../core/billing";
import { getBillingCustomerId, saveBillingCustomerId } from "../aws/dynamodb/dynamo-entities/billing";
import { getStripe } from "./stripe";

/*
 * Stripe Billing on the platform account (progress.md P.5): Ceseelia charging merchants for a
 * plan. Nothing here uses a connected account (`stripeAccount`); shopper payments (5.4) do.
 * Stripe Tax is on (`automatic_tax`) for Ceseelia's own GST/HST: the opposite of the shopper
 * checkout, which must never enable it.
 */

type BillingCurrency = "CAD" | "USD" | "AUD";

/* The plan's price isn't set up in Stripe (or doesn't match PLANS): routes answer 503. */
export class BillingNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`Billing is not configured: ${reason}`);
    this.name = "BillingNotConfiguredError";
  }
}

const PRICE_CACHE_MS = 10 * 60 * 1000;
const priceCache = new Map<string, { id: string; at: number }>();

/*
 * The Stripe price for a plan, found by lookup key (`ceseelia_spark_cad`; created by
 * scripts/setup-billing-prices.mjs). It must charge exactly what PLANS says, monthly, in that
 * currency, or nobody is charged a price the app didn't show.
 */
export async function resolvePlanPrice(plan: StorePlan, currency: BillingCurrency): Promise<string> {
  const key = planPriceLookupKey(plan, currency);
  if (!key) throw new BillingNotConfiguredError(`${plan} has no price`);
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.at < PRICE_CACHE_MS) return cached.id;

  const stripe = await getStripe();
  const { data } = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  const price = data[0];
  const expected = PLANS[plan].monthlyPriceMinor[currency];
  if (
    !price ||
    price.currency.toUpperCase() !== currency ||
    price.unit_amount !== expected ||
    price.type !== "recurring" ||
    price.recurring?.interval !== "month" ||
    price.recurring?.interval_count !== 1
  ) {
    throw new BillingNotConfiguredError(`price "${key}" is missing or doesn't match ${expected} ${currency}/month`);
  }
  priceCache.set(key, { id: price.id, at: Date.now() });
  return price.id;
}

/** Tests only. */
export function resetBillingPriceCache(): void {
  priceCache.clear();
}

/* The account's Stripe Customer for this currency, created the first time. */
export async function ensureBillingCustomer(
  user: { userId: string; email: string; name: string },
  currency: BillingCurrency
): Promise<string> {
  const existing = await getBillingCustomerId(user.userId, currency);
  if (existing) return existing;
  const stripe = await getStripe();
  const customer = await stripe.customers.create(
    {
      ...(user.email ? { email: user.email } : {}),
      ...(user.name ? { name: user.name } : {}),
      metadata: { userId: user.userId, currency },
    },
    // Two clicks at once get the same customer back.
    { idempotencyKey: `ceseelia-billing-customer-${user.userId}-${currency}` }
  );
  return saveBillingCustomerId(user.userId, currency, customer.id);
}

const CHECKOUT_LIFETIME_S = 60 * 60; // Stripe's minimum is 30 minutes

/* A Billing Checkout for the store's plan. The webhook does the rest once it's paid. */
export async function createPlanCheckout(input: {
  storeId: string;
  storeName: string;
  plan: StorePlan;
  currency: BillingCurrency;
  userId: string;
  customerId: string;
}): Promise<{ sessionId: string; url: string; expiresAt: number }> {
  const price = await resolvePlanPrice(input.plan, input.currency);
  const stripe = await getStripe();
  const metadata = { storeId: input.storeId, userId: input.userId, plan: input.plan };
  const back = `${WEBAPP_URL.replace(/\/$/, "")}/store/storefront/${input.storeId}`;
  const expiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME_S;
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: input.customerId,
    line_items: [{ price, quantity: 1 }],
    automatic_tax: { enabled: true },
    customer_update: { address: "auto", name: "auto" },
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    client_reference_id: input.storeId,
    metadata,
    subscription_data: {
      metadata,
      description: `${PLANS[input.plan].name} plan for ${input.storeName || "your store"}`.slice(0, 500),
    },
    success_url: `${back}?billing=success`,
    cancel_url: `${back}?billing=cancel`,
    expires_at: expiresAt,
  });
  if (!session.url) throw new BillingNotConfiguredError("Checkout returned no URL");
  return { sessionId: session.id, url: session.url, expiresAt: expiresAt * 1000 };
}

/* Best effort: close an older open checkout so it can't also be paid. */
export async function expirePlanCheckout(sessionId: string): Promise<void> {
  try {
    const stripe = await getStripe();
    await stripe.checkout.sessions.expire(sessionId);
  } catch {
    // already completed or expired: the webhook sorts out a double payment (mayReplace)
  }
}

/* The Customer Portal for card changes, plan changes and cancelling. */
export async function createBillingPortal(customerId: string, storeId: string): Promise<string> {
  const stripe = await getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${WEBAPP_URL.replace(/\/$/, "")}/store/storefront/${storeId}?billing=portal`,
  });
  return session.url;
}

/* A subscription as the sync needs it, read fresh from Stripe. Null when it doesn't exist. */
export async function retrieveSubscriptionSnapshot(subscriptionId: string): Promise<SubscriptionSnapshot | null> {
  const stripe = await getStripe();
  try {
    return toSnapshot(await stripe.subscriptions.retrieve(subscriptionId));
  } catch (e) {
    if (e instanceof Stripe.errors.StripeInvalidRequestError && e.code === "resource_missing") return null;
    throw e;
  }
}

export function toSnapshot(sub: Stripe.Subscription): SubscriptionSnapshot {
  const items = sub.items?.data ?? [];
  // One item per subscription (one plan); the plan comes from our price's lookup key, which
  // also follows plan changes made in the portal (metadata doesn't).
  const plan = items.map((i) => planFromLookupKey(i.price?.lookup_key)?.plan).find(Boolean) ?? null;
  const periodEnds = items.map((i) => i.current_period_end).filter((n): n is number => typeof n === "number");
  const md = sub.metadata ?? {};
  return {
    id: sub.id,
    customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    status: sub.status,
    plan,
    currency: (sub.currency ?? "").toUpperCase(),
    currentPeriodEnd: periodEnds.length ? Math.max(...periodEnds) * 1000 : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true || typeof sub.cancel_at === "number",
    cancellationReason: sub.cancellation_details?.reason ?? null,
    endedAt: typeof sub.ended_at === "number" ? sub.ended_at * 1000 : null,
    metadata: {
      ...(typeof md.storeId === "string" ? { storeId: md.storeId } : {}),
      ...(typeof md.userId === "string" ? { userId: md.userId } : {}),
      ...(typeof md.plan === "string" ? { plan: md.plan } : {}),
    },
  };
}

/* End a subscription now (the store is gone, or it's a second one for the same store). */
export async function cancelSubscriptionNow(subscriptionId: string): Promise<void> {
  const stripe = await getStripe();
  try {
    await stripe.subscriptions.cancel(subscriptionId, { prorate: true });
  } catch (e) {
    if (e instanceof Stripe.errors.StripeInvalidRequestError && e.code === "resource_missing") return;
    throw e;
  }
}
