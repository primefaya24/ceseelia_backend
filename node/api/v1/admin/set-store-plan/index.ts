import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { isUlid } from "../../../../layers/core/utils";
import { isStorePlan, NO_PLAN, StorePlanOrNone } from "../../../../layers/core/plans";
import { StoreStatusChangedError } from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { getStoreAdminState, saveAdminPlan } from "../../../../layers/aws/dynamodb/dynamo-entities/store-admin";
import { lifecycleWithAdminPlan } from "../../../../layers/core/review";
import { blocksNewSubscription } from "../../../../layers/core/billing";
import { sendServerError } from "../route-errors";

/*
 * PUT /admin/set-store-plan { storeId, plan: "SPARK" | "NOVA" | "NONE" } (admin, progress.md P.8)
 * → { status, plan, planSetByAdmin }
 * Gives a store a plan without a subscription (a deal, a free month, support), or takes it away
 * (NONE). Giving one leaves the status alone: a draft still goes live through Go Live, which then
 * needs no checkout. Taking it away sends a live store back to a DRAFT: no plan, not live (no
 * Free plan, 2026-11-13). The fee follows the plan unless the admin settings say CUSTOM (P.6).
 * 409 HAS_SUBSCRIPTION: the store pays for a plan (or is in payment grace); change that in
 *   Stripe, or the next payment would undo this. 409 STATUS_CHANGED · 404 STORE_NOT_FOUND
 */
export default function registerRoute(router: Router): void {
  router.put("/set-store-plan", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => isUlid(req.body.storeId) && typeof req.body.plan === "string",
      (req) => isStorePlan(req.body.plan) || req.body.plan === NO_PLAN,
      executeRouteCore,
      true,
      /* admins only */ true
    );
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const storeId = String(req.body.storeId);
    const plan = req.body.plan as StorePlanOrNone;
    const state = await getStoreAdminState(storeId);
    if (!state) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "STORE_NOT_FOUND", message: "Store not found" });
      return;
    }
    if (blocksNewSubscription(state.subscription, Date.now())) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({
        code: "HAS_SUBSCRIPTION",
        message: "This store pays for its plan. Change or cancel the subscription in Stripe first.",
      });
      return;
    }
    const lifecycle = lifecycleWithAdminPlan(state.lifecycle, plan);
    await saveAdminPlan(state, lifecycle);
    res.send({
      status: lifecycle.status,
      plan: lifecycle.plan,
      planSetByAdmin: lifecycle.planSetByAdmin === true,
    });
  } catch (e) {
    if (e instanceof StoreStatusChangedError) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code: "STATUS_CHANGED", message: "The store just changed. Reload." });
      return;
    }
    sendServerError(e, res, "In set-store-plan");
  }
}
