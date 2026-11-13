import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { getAuth, storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import {
  getStoreInventoryData,
  setStoreStatusFromDraft,
  StoreStatusChangedError,
} from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { findLiveFreeStoreAdministeredBy } from "../../../../../layers/aws/dynamodb/dynamo-entities/membership";
import { goLiveChecklist } from "../../../../../layers/core/go-live";
import { readStoreStripeAccount } from "../../../../../layers/payments/account-status";
import { normalizeAdminSettings, normalizeStoreLifecycle } from "../../../../../layers/core/interfaces/store";
import { isPlanAvailable, isStorePlan, StorePlan } from "../../../../../layers/core/plans";
import {
  runSmartStoreValidation,
  SmartStoreValidationResult,
} from "../../../../../layers/core/store-validation";
import { getStoreBillingState } from "../../../../../layers/aws/dynamodb/dynamo-entities/billing";
import { blocksNewSubscription } from "../../../../../layers/core/billing";
import { billingCurrencyFor } from "../../../../../layers/core/go-live";
import { isPaidPlan } from "../../../../../layers/core/plans";
import { callerUserId, sendBillingError, startPlanCheckout } from "../../billing/shared";

/*
 * POST /store/go-live { storeId, plan } (store ADMINs and platform admins, progress.md P.4b)
 * → 200 { status: "LIVE" | "IN_REVIEW", plan }, or for SPARK / NOVA once everything passed
 *   200 { status: "DRAFT", plan, checkoutUrl } (P.5): the store goes live from the billing
 *   webhook once the subscription is paid. A flagged store goes to IN_REVIEW without a charge.
 *
 * Everything is checked again on the server, in this order; nothing the client says is trusted:
 *   409 STORE_SUSPENDED · 409 ALREADY_LIVE · 409 IN_REVIEW (only a DRAFT can go live)
 *   409 PLAN_NOT_AVAILABLE (SPARK / NOVA while PAID_PLANS_ENABLED is off)
 *   409 ALREADY_SUBSCRIBED (paid: the store already has a subscription)
 *   409 CHECKLIST_INCOMPLETE { steps } (P.4a's checklist, with Stripe read live)
 *   409 FREE_PLAN_IN_USE (the caller already has another live FREE store; not for platform admins)
 * Then runSmartStoreValidation (P.4c, a TODO stub that passes every store for now): passed →
 * LIVE; flagged, or the check failed → IN_REVIEW with the reasons kept for admins. The write
 * is conditional on the store still being a DRAFT: 409 STATUS_CHANGED if it moved meanwhile.
 * 404 STORE_NOT_FOUND · 503 PAYMENTS_NOT_CONFIGURED / BILLING_NOT_CONFIGURED · 502 STRIPE_ERROR
 */
export default function registerRoute(router: Router): void {
  router.post("/", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => typeof req.body.plan === "string",
      (req) => isStorePlan(req.body.plan),
      executeRouteCore,
      true,
      storeMember((req) => req.body.storeId, "ADMIN")
    );
  });
}

const conflict = (res: Response, code: string, message: string, extra: object = {}) =>
  res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code, message, ...extra });

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const storeId = String(req.body.storeId);
    const plan = req.body.plan as StorePlan;
    const auth = getAuth(res);

    const data = await getStoreInventoryData(storeId);
    const lifecycle = normalizeStoreLifecycle(data.settings.lifecycle);
    if (normalizeAdminSettings(data.settings.admin).suspended) {
      return void conflict(res, "STORE_SUSPENDED", "This store is suspended. Contact support.");
    }
    if (lifecycle.status === "LIVE") return void conflict(res, "ALREADY_LIVE", "This store is already live.");
    if (lifecycle.status === "IN_REVIEW") {
      return void conflict(res, "IN_REVIEW", "We're reviewing this store. We'll let you know when it's live.");
    }
    // P.8: a plan an admin gave this store needs no checkout (and no PAID_PLANS_ENABLED).
    const gifted = isPaidPlan(plan) && lifecycle.planSetByAdmin === true && lifecycle.plan === plan;
    if (!gifted && !isPlanAvailable(plan)) {
      return void conflict(res, "PLAN_NOT_AVAILABLE", "This plan isn't available yet. Go live on Free for now.");
    }

    const billing = isPaidPlan(plan) && !gifted ? await getStoreBillingState(storeId) : null;
    if (billing && blocksNewSubscription(billing.subscription, Date.now())) {
      return void conflict(res, "ALREADY_SUBSCRIBED", "This store already has a plan.");
    }

    const stripe = await readStoreStripeAccount(storeId);
    const steps = goLiveChecklist(data, { chargesEnabled: stripe.connected && stripe.chargesEnabled });
    if (!steps.every((s) => s.ok)) {
      return void conflict(res, "CHECKLIST_INCOMPLETE", "A few things are still needed before going live.", { steps });
    }

    if (plan === "FREE" && !auth.isAdmin && auth.userId) {
      if ((await findLiveFreeStoreAdministeredBy(auth.userId, storeId)) !== null) {
        return void conflict(res, "FREE_PLAN_IN_USE", "You already have a live store on the Free plan.");
      }
    }

    let result: SmartStoreValidationResult;
    try {
      // P.8: an admin already approved this store after review; don't send it back.
      result = lifecycle.reviewApprovedAt ? { ok: true } : await runSmartStoreValidation({ storeId, data });
    } catch (e) {
      // Fail closed: a check that couldn't run sends the store to a human, never straight live.
      console.error("In go-live: runSmartStoreValidation", e);
      result = { ok: false, reasons: ["VALIDATION_UNAVAILABLE"] };
    }

    if (result.ok && billing && stripe.connected) {
      // Paid plan: nothing changes until the subscription is paid (the webhook takes it live).
      const currency = billingCurrencyFor(stripe.account.country);
      const userId = await callerUserId(res);
      if (!currency || !userId) {
        return void conflict(res, "PAYMENTS_NOT_CONNECTED", "Connect Stripe first: plans are billed in its currency.");
      }
      const checkoutUrl = await startPlanCheckout({ state: billing, plan, currency, userId });
      return void res.send({ status: "DRAFT", plan, checkoutUrl });
    }

    const saved = await setStoreStatusFromDraft(storeId, {
      status: result.ok ? "LIVE" : "IN_REVIEW",
      plan,
      previous: lifecycle,
      ...(result.ok ? {} : { review: { reasons: result.reasons, requestedByUserId: auth.userId ?? null } }),
    });
    res.send({ status: saved.status, plan: saved.plan });
  } catch (e) {
    if (e instanceof StoreStatusChangedError) {
      return void conflict(res, "STATUS_CHANGED", "This store's status just changed. Reload and try again.");
    }
    sendBillingError(e, res, "In go-live");
  }
}
