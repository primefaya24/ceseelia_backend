import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { getAuth, storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { isUlid } from "../../../../../layers/core/utils";
import {
  merchantOrderView,
  REFUNDABLE_ORDER_STATUSES,
  refundableMinor,
  StoreOrder,
  StoreOrderRefund,
} from "../../../../../layers/core/interfaces/store";
import { appendOrderRefund, getOrderById, recordOrderRefund } from "../../../../../layers/aws/dynamodb/dynamo-entities/order";
import {
  createOrderRefund,
  refundRefusal,
  STRIPE_REFUND_REASONS,
  StripeRefundReason,
} from "../../../../../layers/payments/order-refund";
import { PaymentsNotConfiguredError } from "../../../../../layers/payments/stripe";

/*
 * POST /store/orders/refund (store ADMINs and platform admins, progress.md 6.4)
 * Body { storeId, orderId, amountMinor, refundedMinor, reason? } → 200 { order, refund }
 *
 * Refunds part or all of a paid order on the store's connected account (direct charge, 5.1),
 * the same as a refund in the merchant's Stripe dashboard. `refundedMinor` is the refunded total
 * the merchant was looking at; the refund only happens from it, and it names the idempotency key,
 * so a double click makes one refund. A refund of the whole remainder makes the order REFUNDED.
 * The platform keeps its fee (`REFUND_APPLICATION_FEE`). Stock isn't put back.
 *
 *   - 409 NOT_REFUNDABLE { order }: unpaid, cancelled or already refunded in full.
 *   - 409 REFUND_CHANGED { order }: the refunded total moved meanwhile (another refund, here or
 *     in the dashboard); the current order comes back.
 *   - 409 AMOUNT_TOO_LARGE { order }: more than is left to refund (also when Stripe says so).
 *   - 409 ORDER_DISPUTED { order }: the payment has an open or lost dispute; Stripe handles it.
 *   - 409 INSUFFICIENT_BALANCE { order }: the merchant's Stripe balance can't cover it.
 *   - 404 ORDER_NOT_FOUND (also another store's order) · 503 PAYMENTS_NOT_CONFIGURED ·
 *     502 STRIPE_ERROR.
 *
 * Money moves, so MERCHANT members can't refund; only the store's ADMINs can.
 */
export default function registerRoute(router: Router): void {
  router.post("/refund", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      pureRequestParams,
      validRequestParams,
      executeRouteCore,
      true,
      storeMember((req) => req.body.storeId, "ADMIN")
    );
  });
}

/* Dispute statuses that block a refund: still open, or lost (the money is already gone). */
const BLOCKING_DISPUTES = ["warning_needs_response", "warning_under_review", "needs_response", "under_review", "lost"];

const isReason = (v: unknown): v is StripeRefundReason => (STRIPE_REFUND_REASONS as readonly unknown[]).includes(v);

function pureRequestParams(req: Request): boolean {
  const b = req.body;
  return (
    typeof b?.storeId === "string" &&
    typeof b.orderId === "string" &&
    typeof b.amountMinor === "number" &&
    typeof b.refundedMinor === "number" &&
    (b.reason === undefined || b.reason === null || typeof b.reason === "string")
  );
}

function validRequestParams(req: Request): boolean {
  const b = req.body;
  return (
    isUlid(b.storeId) &&
    isUlid(b.orderId) &&
    Number.isSafeInteger(b.amountMinor) &&
    b.amountMinor > 0 &&
    Number.isSafeInteger(b.refundedMinor) &&
    b.refundedMinor >= 0 &&
    (b.reason === undefined || b.reason === null || isReason(b.reason))
  );
}

const conflict = (res: Response, code: string, message: string, order: StoreOrder) =>
  res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code, message, order: merchantOrderView(order) });

const notFound = (res: Response) =>
  res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "ORDER_NOT_FOUND", message: "Order not found" });

const REFUSAL_MESSAGES = {
  ALREADY_REFUNDED: ["NOT_REFUNDABLE", "This order is already refunded in full."],
  AMOUNT_TOO_LARGE: ["AMOUNT_TOO_LARGE", "That's more than is left to refund."],
  DISPUTED: ["ORDER_DISPUTED", "This payment is disputed. Respond to the dispute in Stripe instead."],
  INSUFFICIENT_BALANCE: ["INSUFFICIENT_BALANCE", "Your Stripe balance can't cover this refund. Add funds in Stripe and try again."],
} as const;

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  const { storeId, orderId } = req.body as { storeId: string; orderId: string };
  const amountMinor = req.body.amountMinor as number;
  const seenRefundedMinor = req.body.refundedMinor as number;
  const reason = (req.body.reason ?? null) as StripeRefundReason | null;
  try {
    const order = await getOrderById(orderId);
    if (!order || order.storeId !== storeId) {
      notFound(res);
      return;
    }
    const paymentIntentId = order.storeOrderStripe?.paymentIntentId ?? "";
    const stripeAccount = order.storeOrderStripe?.accountId ?? "";
    if (!REFUNDABLE_ORDER_STATUSES.includes(order.storeOrderStatus) || !paymentIntentId || !stripeAccount) {
      conflict(res, "NOT_REFUNDABLE", "This order can't be refunded.", order);
      return;
    }
    if ((order.storeOrderRefundedMinor ?? 0) !== seenRefundedMinor) {
      conflict(res, "REFUND_CHANGED", "This order's refunds changed meanwhile.", order);
      return;
    }
    if (amountMinor > refundableMinor(order)) {
      conflict(res, "AMOUNT_TOO_LARGE", "That's more than is left to refund.", order);
      return;
    }
    if (order.storeOrderDispute && BLOCKING_DISPUTES.includes(order.storeOrderDispute.status)) {
      conflict(res, "ORDER_DISPUTED", REFUSAL_MESSAGES.DISPUTED[1], order);
      return;
    }

    const auth = getAuth(res);
    const by = auth.isAdmin ? "ADMIN" : (auth.userId ?? auth.cognitoId);
    let result;
    try {
      result = await createOrderRefund({
        stripeAccount,
        paymentIntentId,
        amountMinor,
        orderId,
        storeId,
        by,
        ...(reason ? { reason } : {}),
        idempotencyKey: `ceseelia-refund-${orderId}-${seenRefundedMinor}-${amountMinor}`,
      });
    } catch (e) {
      if (e instanceof PaymentsNotConfiguredError) {
        res.status(503).send({ code: "PAYMENTS_NOT_CONFIGURED", message: "Payments aren't available right now." });
        return;
      }
      const refusal = refundRefusal(e);
      if (refusal) {
        const [code, message] = REFUSAL_MESSAGES[refusal];
        conflict(res, code, message, (await getOrderById(orderId)) ?? order);
        return;
      }
      console.error(`In store/orders/refund: Stripe refused order ${orderId}`, (e as Error)?.message);
      res.status(502).send({ code: "STRIPE_ERROR", message: "Stripe couldn't make the refund. Please try again." });
      return;
    }

    // The money has moved; from here on, record it as best we can (the webhook syncs it too).
    const now = Date.now();
    const entry: StoreOrderRefund = { refundId: result.refundId, amountMinor, status: result.status, reason, at: now, by };
    const refundedTotal = Math.max(result.chargeRefundedMinor, seenRefundedMinor + amountMinor);
    const full = result.chargeFullyRefunded || refundedTotal >= order.storeOrderTotalMinor;
    try {
      await recordOrderRefund(order, refundedTotal, full, now);
      await appendOrderRefund(order, entry);
    } catch (e) {
      console.error(`In store/orders/refund: refund ${result.refundId} made, but order ${orderId} not updated`, e);
    }
    const current = (await getOrderById(orderId)) ?? {
      ...order,
      storeOrderRefundedMinor: refundedTotal,
      ...(full ? { storeOrderStatus: "REFUNDED" as const } : {}),
    };
    res.send({ order: merchantOrderView(current), refund: entry });
  } catch (e) {
    console.error("In store/orders/refund", e);
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
