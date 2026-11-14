import { Request, Response, Router } from "express";
import { getAuth, storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { getStoreInventoryData } from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { billingCurrencyFor, goLiveChecklist } from "../../../../../layers/core/go-live";
import { readStoreStripeAccount } from "../../../../../layers/payments/account-status";
import {
  normalizeAdminSettings,
  normalizeStoreLifecycle,
} from "../../../../../layers/core/interfaces/store";
import { NO_PLAN } from "../../../../../layers/core/plans";
import { sendPaymentsError } from "../../payments/errors";
import { planOptions } from "../shared";

/*
 * GET /store/go-live/checklist/:storeId (store members, progress.md P.4a)
 * → { status, plan, suspended, canGoLive, ready, steps: [{id, ok, message}], billingCurrency,
 *     plans: [{id, name, monthlyPriceMinor, commissionMinor, customDomain, available,
 *              unavailableReason}] }
 * steps: STORE_NAME, ITEMS, FULFILMENT, PAYMENTS (Stripe read live, as payments/status does).
 * ready: every step ok. canGoLive: this user may press Go Live (platform admin or store ADMIN).
 * billingCurrency: from the Stripe account's country (A1), null until it's connected.
 * plan: NONE until the store has one (a live store always has one). Plans are
 * PLAN_NOT_AVAILABLE while PAID_PLANS_ENABLED is off, except one an admin gave.
 * POST /store/go-live checks all of this again.
 * 404 STORE_NOT_FOUND · 503 PAYMENTS_NOT_CONFIGURED · 502 STRIPE_ERROR
 */
export default function registerRoute(router: Router): void {
  router.get("/checklist/:storeId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      () => true,
      () => true,
      executeRouteCore,
      true,
      storeMember((req) => req.params.storeId)
    );
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const storeId = req.params.storeId as string;
    const auth = getAuth(res);
    const [data, stripe] = await Promise.all([getStoreInventoryData(storeId), readStoreStripeAccount(storeId)]);
    const lifecycle = normalizeStoreLifecycle(data.settings.lifecycle);
    const steps = goLiveChecklist(data, {
      chargesEnabled: stripe.connected && stripe.chargesEnabled,
    });
    const gifted = lifecycle.planSetByAdmin && lifecycle.plan !== NO_PLAN ? lifecycle.plan : null;
    const currency = stripe.connected ? billingCurrencyFor(stripe.account.country) : null;
    res.send({
      status: lifecycle.status,
      pausedReason: lifecycle.pausedReason ?? null,
      // P.8: the admin's answer after a review, and a plan an admin gave (goes live without paying).
      reviewRejection: lifecycle.reviewRejection ?? null,
      reviewApproved: lifecycle.reviewApprovedAt !== undefined,
      giftedPlan: gifted,
      plan: lifecycle.plan,
      suspended: normalizeAdminSettings(data.settings.admin).suspended,
      canGoLive: auth.isAdmin || auth.storeRole === "ADMIN",
      ready: steps.every((s) => s.ok),
      steps,
      billingCurrency: currency,
      plans: planOptions(currency, gifted),
    });
  } catch (e) {
    sendPaymentsError(e, res, "In go-live/checklist");
  }
}
