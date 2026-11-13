import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { getAuth, storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { getStoreBillingState } from "../../../../../layers/aws/dynamodb/dynamo-entities/billing";
import { blocksNewSubscription } from "../../../../../layers/core/billing";
import { sendBillingError } from "../shared";

/*
 * GET /store/billing/status/:storeId (store members, progress.md P.5)
 * → { status, plan, pausedReason, suspended, canManage, checkoutPending,
 *     subscription: { plan, status, currency, currentPeriodEnd, cancelAtPeriodEnd, graceEndsAt,
 *                     isPayer } | null }
 * `canManage` = may start a checkout (store ADMIN or platform admin); `isPayer` = may open the
 * billing portal (only the user who subscribed: the portal shows their card and invoices).
 * No ids (customer, subscription) are sent.
 */
export default function registerRoute(router: Router): void {
  router.get("/status/:storeId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, () => true, () => true, executeRouteCore, true, storeMember((req) => req.params.storeId));
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const state = await getStoreBillingState(String(req.params.storeId));
    if (!state) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "STORE_NOT_FOUND", message: "Store not found" });
      return;
    }
    const auth = getAuth(res);
    const sub = state.subscription;
    const now = Date.now();
    res.set("Cache-Control", "no-store").send({
      status: state.lifecycle.status,
      plan: state.lifecycle.plan,
      pausedReason: state.lifecycle.pausedReason ?? null,
      suspended: state.suspended,
      canManage: auth.isAdmin || auth.storeRole === "ADMIN",
      checkoutPending: !!state.checkout && state.checkout.expiresAt > now,
      subscription:
        sub && (blocksNewSubscription(sub, now) || sub.status === "canceled" || sub.status === "unpaid")
          ? {
              plan: sub.plan,
              status: sub.status,
              currency: sub.currency,
              currentPeriodEnd: sub.currentPeriodEnd,
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
              graceEndsAt: sub.graceEndsAt,
              isPayer: !!auth.userId && auth.userId === sub.payerUserId,
            }
          : null,
    });
  } catch (e) {
    sendBillingError(e, res, "In store/billing/status");
  }
}
