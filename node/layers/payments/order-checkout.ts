import Stripe from "stripe";
import { WEBAPP_URL } from "../../config";
import { Quote } from "../core/pricing";
import { getStripe } from "./stripe";

/*
 * The shopper's Checkout Session for an order (5.4c): a **direct charge on the store's connected
 * account** (Stripe Connect Standard), with the platform fee taken from the merchant as
 * `application_fee_amount`. The amounts are exactly the server's quote:
 *   - one Stripe line per order line, quantity 1, for the line's total after discount (a line's
 *     discount is rounded per line, so total ÷ quantity isn't always whole cents);
 *   - delivery as its own line;
 *   - each tax part as its own line, unless the prices already include tax.
 * So the session's total is the quote's total. **Never** `automatic_tax` or `tax_id_collection`:
 * the merchant may have Stripe Tax on their own account, and it would tax the shopper twice.
 */
type LineItem = Stripe.Checkout.SessionCreateParams.LineItem;

const line = (currency: string, name: string, amount: number): LineItem => ({
  quantity: 1,
  price_data: { currency: currency.toLowerCase(), unit_amount: amount, product_data: { name: name.slice(0, 250) } },
});

export function checkoutLineItems(quote: Quote): LineItem[] {
  const items: LineItem[] = quote.lines.map((l) => {
    const picks = l.params.map((p) => p.values.join(", ")).filter(Boolean).join(" · ");
    const name = `${l.itemName}${picks ? ` (${picks})` : ""}${l.quantity > 1 ? ` × ${l.quantity}` : ""}`;
    return line(quote.currency, name, l.totalMinor);
  });
  if (quote.deliveryMinor > 0) items.push(line(quote.currency, "Delivery", quote.deliveryMinor));
  if (!quote.pricesIncludeTax) {
    for (const t of quote.taxLines) if (t.minor > 0) items.push(line(quote.currency, `${t.label} ${t.percent}%`, t.minor));
  }
  return items;
}

export const sumLineItems = (items: LineItem[]) =>
  items.reduce((sum, i) => sum + (i.price_data?.unit_amount ?? 0) * (i.quantity ?? 1), 0);

/** Stripe's lowest charge (≈ 0.50 in CAD, USD, AUD). */
export const MIN_CHARGE_MINOR = 50;
/** How long the shopper has to pay (Stripe's minimum is 30 minutes). */
export const ORDER_CHECKOUT_LIFETIME_S = 30 * 60;

export function orderSessionParams(input: {
  orderId: string;
  storeId: string;
  storeSlug: string;
  quote: Quote;
  feeMinor: number;
  customerEmail: string;
  now?: number;
}): Stripe.Checkout.SessionCreateParams {
  const base = `${WEBAPP_URL.replace(/\/$/, "")}/s/${input.storeSlug}`;
  const metadata = { orderId: input.orderId, storeId: input.storeId };
  return {
    mode: "payment",
    line_items: checkoutLineItems(input.quote),
    customer_email: input.customerEmail,
    client_reference_id: input.orderId,
    metadata,
    payment_intent_data: { application_fee_amount: input.feeMinor, metadata },
    // The status token stays in the shopper's browser; it never goes to Stripe.
    success_url: `${base}/order/${input.orderId}?paid=1`,
    cancel_url: `${base}/checkout?cancelled=${input.orderId}`,
    expires_at: Math.floor((input.now ?? Date.now()) / 1000) + ORDER_CHECKOUT_LIFETIME_S,
  };
}

export async function createOrderCheckout(
  params: Stripe.Checkout.SessionCreateParams,
  stripeAccount: string,
  orderId: string
): Promise<{ sessionId: string; url: string }> {
  const stripe = await getStripe();
  const session = await stripe.checkout.sessions.create(params, {
    stripeAccount,
    idempotencyKey: `ceseelia-order-${orderId}`,
  });
  if (!session.url) throw new Error("Checkout returned no URL");
  return { sessionId: session.id, url: session.url };
}

/* Best effort: close a session whose order couldn't be saved, so it can't be paid. */
export async function expireOrderCheckout(sessionId: string, stripeAccount: string): Promise<void> {
  try {
    const stripe = await getStripe();
    await stripe.checkout.sessions.expire(sessionId, {}, { stripeAccount });
  } catch {
    // already expired or completed: the webhook finds no order and leaves it
  }
}
