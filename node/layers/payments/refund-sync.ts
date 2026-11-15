import { StoreOrder } from "../core/interfaces/store";
import { LiveRefund, orderRefundState, sameRefundState } from "../core/refunds";
import { getOrderById, writeOrderRefundState } from "../aws/dynamodb/dynamo-entities/order";
import { getStripe } from "./stripe";

/*
 * Sync an order's refunds from Stripe (6.4b): lists the payment's refunds on the store's
 * connected account, works out the state (`orderRefundState`) and writes it if it changed.
 * Used by every refund event (`charge.refunded`, `charge.refund.updated`, `refund.*`) and after
 * our own refund route, so a refund that fails later stops counting and the order goes back
 * from REFUNDED. Retries when the order changed while it was being synced.
 */
const TRIES = 3;

export async function listPaymentRefunds(order: StoreOrder): Promise<LiveRefund[]> {
  const stripe = await getStripe();
  const out: LiveRefund[] = [];
  const pages = stripe.refunds.list(
    { payment_intent: order.storeOrderStripe.paymentIntentId, limit: 100 },
    { stripeAccount: order.storeOrderStripe.accountId }
  );
  for await (const r of pages) {
    out.push({ id: r.id, amount: r.amount, status: r.status, created: r.created, failure_reason: r.failure_reason ?? null });
  }
  return out;
}

/* The order after syncing (as written, or unchanged), or null if it's gone. */
export async function syncOrderRefunds(orderId: string): Promise<StoreOrder | null> {
  for (let i = 0; i < TRIES; i++) {
    const order = await getOrderById(orderId);
    if (!order) return null;
    if (!order.storeOrderStripe?.paymentIntentId || !order.storeOrderStripe.accountId) return order;
    const state = orderRefundState(order, await listPaymentRefunds(order));
    if (sameRefundState(order, state)) return order;
    const now = Date.now();
    if (await writeOrderRefundState(order, state, now)) {
      return { ...order, ...state, storeOrderUpdatedAt: Math.max(now, order.storeOrderUpdatedAt + 1) };
    }
  }
  throw new Error(`Order ${orderId}: refunds kept changing while syncing`);
}
