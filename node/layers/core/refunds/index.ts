import {
  REFUNDABLE_ORDER_STATUSES,
  STORE_ORDER_PROGRESS,
  StoreOrder,
  StoreOrderFailedRefund,
  StoreOrderRefund,
  StoreOrderStatus,
} from "../interfaces/store";

/*
 * An order's refunds as Stripe has them now (6.4b). Every refund event, and our own refund
 * route, re-reads the payment's refunds from Stripe and writes what this works out, so events
 * arriving late or out of order can't leave the order wrong, and a refund that fails later
 * (bank debits, closed cards, a short balance) stops counting.
 */

/** The parts of a Stripe Refund this needs. */
export interface LiveRefund {
  id: string;
  amount: number;
  status: string | null;
  /** Seconds, as Stripe sends it. */
  created: number;
  failure_reason?: string | null;
}

/* Refunds that count: done, or still on their way. `failed` / `canceled` don't. */
const COUNTS = ["succeeded", "pending", "requires_action"];

export interface OrderRefundState {
  storeOrderRefundedMinor: number;
  storeOrderStatus: StoreOrderStatus;
  storeOrderRefunds: StoreOrderRefund[];
  storeOrderFailedRefunds: StoreOrderFailedRefund[];
}

/*
 * The status an order goes back to when a full refund stops being full: the merchant's last
 * step before it, or PAID.
 */
function statusBeforeRefund(order: StoreOrder): StoreOrderStatus {
  const steps = (order.storeOrderStatusHistory ?? []).map((h) => h.status).filter((s) => STORE_ORDER_PROGRESS.includes(s));
  return steps[steps.length - 1] ?? "PAID";
}

export function orderRefundState(order: StoreOrder, live: LiveRefund[]): OrderRefundState {
  const counted = live.filter((r) => COUNTS.includes(r.status ?? ""));
  const refundedMinor = Math.min(
    order.storeOrderTotalMinor,
    counted.reduce((n, r) => n + r.amount, 0)
  );
  const full = refundedMinor >= order.storeOrderTotalMinor && order.storeOrderTotalMinor > 0;

  let status = order.storeOrderStatus;
  if (full && REFUNDABLE_ORDER_STATUSES.includes(status)) status = "REFUNDED";
  else if (!full && status === "REFUNDED") status = statusBeforeRefund(order);

  const byId = new Map(live.map((r) => [r.id, r]));
  const refunds = (order.storeOrderRefunds ?? []).map((e) => {
    const now = byId.get(e.refundId)?.status;
    return now && now !== e.status ? { ...e, status: now } : e;
  });
  const failed = live
    .filter((r) => r.status === "failed" || r.status === "canceled")
    .map((r) => ({
      refundId: r.id,
      amountMinor: r.amount,
      status: r.status as string,
      reason: r.failure_reason ?? null,
      at: r.created * 1000,
    }))
    .sort((a, b) => a.at - b.at);

  return {
    storeOrderRefundedMinor: refundedMinor,
    storeOrderStatus: status,
    storeOrderRefunds: refunds,
    storeOrderFailedRefunds: failed,
  };
}

/* True when writing `state` would change nothing. */
export function sameRefundState(order: StoreOrder, state: OrderRefundState): boolean {
  return (
    (order.storeOrderRefundedMinor ?? 0) === state.storeOrderRefundedMinor &&
    order.storeOrderStatus === state.storeOrderStatus &&
    JSON.stringify(order.storeOrderRefunds ?? []) === JSON.stringify(state.storeOrderRefunds) &&
    JSON.stringify(order.storeOrderFailedRefunds ?? []) === JSON.stringify(state.storeOrderFailedRefunds)
  );
}
