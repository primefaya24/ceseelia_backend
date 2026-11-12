import { Response } from "express";
import Stripe from "stripe";
import { appConstants } from "../../../../constants";
import { StoreRecordNotFoundError } from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { PaymentsNotConfiguredError } from "../../../../layers/payments/stripe";
import { sendServerError } from "../../admin/route-errors";

/*
 * Errors shared by the payments routes (5.2):
 *   404 STORE_NOT_FOUND · 503 PAYMENTS_NOT_CONFIGURED (no usable Stripe key) ·
 *   502 STRIPE_ERROR (Stripe refused or is unreachable; its message is logged, not sent) · 500
 */
export function sendPaymentsError(e: unknown, res: Response, where: string): void {
  if (e instanceof StoreRecordNotFoundError) {
    res
      .status(appConstants.HTTP_STATUS_CODE_NOT_FOUND)
      .send({ message: "Store not found", code: "STORE_NOT_FOUND" });
    return;
  }
  if (e instanceof PaymentsNotConfiguredError) {
    console.error(where, e.message);
    res
      .status(503)
      .send({ message: "Payments aren't available right now.", code: "PAYMENTS_NOT_CONFIGURED" });
    return;
  }
  if (e instanceof Stripe.errors.StripeError) {
    console.error(where, `${e.type} ${e.code ?? ""} ${e.message} (request ${e.requestId ?? "-"})`);
    res
      .status(502)
      .send({
        message: "Stripe couldn't complete the request. Please try again.",
        code: "STRIPE_ERROR",
      });
    return;
  }
  sendServerError(e, res, where);
}
