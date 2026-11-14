import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { getAuth, storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import {
  getStoreInventoryData,
  setStoreStatusFromDraft,
  StoreStatusChangedError,
} from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
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
import { callerUserId, sendBillingError, startPlanCheckout } from "../../billing/shared";

/*
 * POST /store/go-live { storeId, plan: "SPARK" | "NOVA" } (store ADMINs and platform admins, P.4b)
 * Going live and subscribing are one step (no Free plan, 2026-11-13):
 * → 200 { status: "DRAFT", plan, checkoutUrl } once everything passed (P.5): the store goes live
 *   from the billing webhook once the subscription is paid.
 * → 200 { status: "LIVE", plan } on a plan an admin gave the store (P.8): no checkout.
 * → 200 { status: "IN_REVIEW", plan } when flagged: no charge until an admin approves.
 *
 * Everything is checked again on the server, in this order; nothing the client says is trusted:
 *   409 STORE_SUSPENDED · 409 ALREADY_LIVE · 409 IN_REVIEW (only a DRAFT can go live)
 *   409 PLAN_NOT_AVAILABLE (while PAID_PLANS_ENABLED is off, unless an admin gave the plan)
 *   409 ALREADY_SUBSCRIBED (the store already has a subscription)
 *   409 CHECKLIST_INCOMPLETE { steps } (P.4a's checklist, with Stripe read live)
 * Then runSmartStoreValidation (P.4c, a TODO stub that passes every store for now): passed →
 * checkout (or LIVE when gifted); flagged, or the check failed → IN_REVIEW with the reasons kept
 * for admins. The write is conditional on the store still being a DRAFT: 409 STATUS_CHANGED.
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
    const gifted = lifecycle.planSetByAdmin === true && lifecycle.plan === plan;
    if (!gifted && !isPlanAvailable(plan)) {
      return void conflict(
        res,
        "PLAN_NOT_AVAILABLE",
        "Plans aren't available yet. Check back soon."
      );
    }

    const billing = gifted ? null : await getStoreBillingState(storeId);
    if (billing && blocksNewSubscription(billing.subscription, Date.now())) {
      return void conflict(res, "ALREADY_SUBSCRIBED", "This store already has a plan.");
    }

    const stripe = await readStoreStripeAccount(storeId);
    const steps = goLiveChecklist(data, { chargesEnabled: stripe.connected && stripe.chargesEnabled });
    if (!steps.every((s) => s.ok)) {
      return void conflict(res, "CHECKLIST_INCOMPLETE", "A few things are still needed before going live.", { steps });
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

    if (result.ok && !gifted) {
      // Nothing changes until the subscription is paid (the webhook takes it live).
      if (!billing)
        return void res
          .status(appConstants.HTTP_STATUS_CODE_NOT_FOUND)
          .send({ code: "STORE_NOT_FOUND", message: "Store not found" });
      const currency = stripe.connected ? billingCurrencyFor(stripe.account.country) : null;
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
    // IN_REVIEW: `plan` is the one asked for; the store has no plan until it pays.
    res.send({ status: saved.status, plan });
  } catch (e) {
    if (e instanceof StoreStatusChangedError) {
      return void conflict(res, "STATUS_CHANGED", "This store's status just changed. Reload and try again.");
    }
    sendBillingError(e, res, "In go-live");
  }
}
