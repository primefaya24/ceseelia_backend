import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { getStoreBillingState } from "../../../../../layers/aws/dynamodb/dynamo-entities/billing";
import { blocksNewSubscription } from "../../../../../layers/core/billing";
import { isPaidPlan, isPlanAvailable, isStorePlan, StorePlan } from "../../../../../layers/core/plans";
import { billingCurrencyFor } from "../../../../../layers/core/go-live";
import { readStoreStripeAccount } from "../../../../../layers/payments/account-status";
import { callerUserId, sendBillingError, startPlanCheckout } from "../shared";

/*
 * POST /store/billing/checkout { storeId, plan } (store ADMINs, progress.md P.5): a LIVE store
 * on FREE moves to SPARK or NOVA → { checkoutUrl }. Drafts go through POST /store/go-live
 * instead (it runs the checklist and validation first); a store already paying changes plan in
 * the billing portal.
 *   400 plan isn't SPARK / NOVA · 409 STORE_SUSPENDED · NOT_LIVE · ALREADY_SUBSCRIBED ·
 *   PLAN_NOT_AVAILABLE · PAYMENTS_NOT_CONNECTED (the billing currency comes from the store's
 *   Stripe country) · 503 BILLING_NOT_CONFIGURED · 502 STRIPE_ERROR
 */
export default function registerRoute(router: Router): void {
  router.post("/checkout", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => typeof req.body.plan === "string",
      (req) => isStorePlan(req.body.plan) && isPaidPlan(req.body.plan),
      executeRouteCore,
      true,
      storeMember((req) => req.body.storeId, "ADMIN")
    );
  });
}

const conflict = (res: Response, code: string, message: string) =>
  res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code, message });

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const storeId = String(req.body.storeId);
    const plan = req.body.plan as StorePlan;
    const state = await getStoreBillingState(storeId);
    if (!state) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "STORE_NOT_FOUND", message: "Store not found" });
      return;
    }
    if (state.suspended) return void conflict(res, "STORE_SUSPENDED", "This store is suspended. Contact support.");
    if (state.lifecycle.status !== "LIVE") {
      return void conflict(res, "NOT_LIVE", "Go live first: the Go live button takes you through it.");
    }
    if (blocksNewSubscription(state.subscription, Date.now())) {
      return void conflict(res, "ALREADY_SUBSCRIBED", "This store already has a plan. Change it in Manage billing.");
    }
    if (!isPlanAvailable(plan)) return void conflict(res, "PLAN_NOT_AVAILABLE", "This plan isn't available yet.");

    const account = await readStoreStripeAccount(storeId);
    const currency = account.connected ? billingCurrencyFor(account.account.country) : null;
    if (!currency) {
      return void conflict(res, "PAYMENTS_NOT_CONNECTED", "Connect Stripe first: plans are billed in its currency.");
    }
    const userId = await callerUserId(res);
    if (!userId) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "PROFILE_NOT_FOUND", message: "Profile not found" });
      return;
    }
    res.send({ checkoutUrl: await startPlanCheckout({ state, plan, currency, userId }) });
  } catch (e) {
    sendBillingError(e, res, "In store/billing/checkout");
  }
}
