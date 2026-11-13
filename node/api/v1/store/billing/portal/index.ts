import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { getAuth, storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { getStoreBillingState } from "../../../../../layers/aws/dynamodb/dynamo-entities/billing";
import { createBillingPortal } from "../../../../../layers/payments/billing";
import { sendBillingError } from "../shared";

/*
 * POST /store/billing/portal { storeId } (store members, progress.md P.5) → { url }: Stripe's
 * Customer Portal for the card, invoices, plan changes and cancelling. Only the user who
 * subscribed can open it (it's their customer: their card, their other stores' invoices).
 *   409 NO_SUBSCRIPTION · 403 NOT_PAYER · 503 · 502
 */
export default function registerRoute(router: Router): void {
  router.post("/portal", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, () => true, () => true, executeRouteCore, true, storeMember((req) => req.body.storeId));
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const storeId = String(req.body.storeId);
    const state = await getStoreBillingState(storeId);
    if (!state) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "STORE_NOT_FOUND", message: "Store not found" });
      return;
    }
    const sub = state.subscription;
    if (!sub) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code: "NO_SUBSCRIPTION", message: "This store has no subscription." });
      return;
    }
    const auth = getAuth(res);
    if (!auth.userId || auth.userId !== sub.payerUserId) {
      res.status(appConstants.HTTP_STATUS_CODE_FORBIDDEN).send({
        code: "NOT_PAYER",
        message: "Only the person who subscribed can manage this store's billing.",
      });
      return;
    }
    res.send({ url: await createBillingPortal(sub.customerId, storeId) });
  } catch (e) {
    sendBillingError(e, res, "In store/billing/portal");
  }
}
