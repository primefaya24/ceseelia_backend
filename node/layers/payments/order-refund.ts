import { getStripe } from "./stripe";

/*
 * Refunds on the store's connected account (6.4). Orders are direct charges (5.1), so the
 * refund is created on the merchant's own account with `stripeAccount`, the same as a refund
 * made in their Stripe dashboard.
 *
 * The platform keeps its application fee on a refund (`refund_application_fee: false`), the
 * same as Stripe does for a dashboard refund. Owner to confirm (progress.md 6.4).
 */
export const REFUND_APPLICATION_FEE = false;

export const STRIPE_REFUND_REASONS = ["requested_by_customer", "duplicate", "fraudulent"] as const;
export type StripeRefundReason = (typeof STRIPE_REFUND_REASONS)[number];

export interface OrderRefundResult {
  refundId: string;
  /** The refund's own status: `succeeded`, or `pending` for some payment methods. */
  status: string;
}

/* Why Stripe turned the refund down, for the route's 409s; null = an unexpected error. */
export type RefundRefusal = "ALREADY_REFUNDED" | "AMOUNT_TOO_LARGE" | "DISPUTED" | "INSUFFICIENT_BALANCE";

export function refundRefusal(e: unknown): RefundRefusal | null {
  const err = e as { type?: string; code?: string; message?: string };
  if (err?.type !== "StripeInvalidRequestError") return null;
  switch (err.code) {
    case "charge_already_refunded":
      return "ALREADY_REFUNDED";
    case "charge_disputed":
      return "DISPUTED";
    case "balance_insufficient":
    case "insufficient_funds":
      return "INSUFFICIENT_BALANCE";
    case "amount_too_large":
      return "AMOUNT_TOO_LARGE";
    default:
      // Stripe answers an over-refund with a plain message and no code on some API versions.
      return /greater than unrefunded amount/i.test(err.message ?? "") ? "AMOUNT_TOO_LARGE" : null;
  }
}

/*
 * Refund `amountMinor` of an order's PaymentIntent. `idempotencyKey` should name the state the
 * merchant saw (order, amount already refunded, amount), so a double click or a retry makes one
 * refund, but a second, deliberate refund of the same amount later makes another.
 */
export async function createOrderRefund(opts: {
  stripeAccount: string;
  paymentIntentId: string;
  amountMinor: number;
  orderId: string;
  storeId: string;
  by: string;
  reason?: StripeRefundReason;
  idempotencyKey: string;
}): Promise<OrderRefundResult> {
  const stripe = await getStripe();
  const refund = await stripe.refunds.create(
    {
      payment_intent: opts.paymentIntentId,
      amount: opts.amountMinor,
      refund_application_fee: REFUND_APPLICATION_FEE,
      ...(opts.reason ? { reason: opts.reason } : {}),
      metadata: { orderId: opts.orderId, storeId: opts.storeId, by: opts.by },
    },
    { stripeAccount: opts.stripeAccount, idempotencyKey: opts.idempotencyKey }
  );
  return { refundId: refund.id, status: refund.status ?? "pending" };
}
