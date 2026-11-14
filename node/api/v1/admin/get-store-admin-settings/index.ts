import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { isUlid } from "../../../../layers/core/utils";
import { getStoreAdminSettings } from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { NO_PLAN, PLANS } from "../../../../layers/core/plans";
import { blocksNewSubscription } from "../../../../layers/core/billing";
import { sendServerError } from "../route-errors";

/*
 * GET /admin/get-store-admin-settings/:storeId (admin, progress.md 1.6)
 * → { commissionSource, commissionMode, commissionPercentBps, salesCommissions, suspended,
 *     plan, planCommissions } (5.1a/5.1b/P.6, defaults filled in by normalizeAdminSettings)
 *   `plan` / `planCommissions` = the store's plan and its default fee per order (cents), what
 *   the store pays while `commissionSource` is PLAN (`plan` NONE: no plan yet, planCommissions null). `planSetByAdmin` (P.8) = an admin gave the
 *   plan; `paysForPlan` = a subscription pays for it (or is in grace), so set-store-plan is
 *   refused. · 404 STORE_NOT_FOUND
 */
export default function registerRoute(router: Router): void {
  router.get("/get-store-admin-settings/:storeId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureRequestParams, () => true, executeRouteCore, true, /* admins only */ true);
  });
}

function pureRequestParams(req: Request): boolean {
  return isUlid(req.params.storeId);
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const found = await getStoreAdminSettings(req.params.storeId as string);
    if (!found) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: "Store not found", code: "STORE_NOT_FOUND" });
      return;
    }
    const plan = found.lifecycle.plan;
    res.send({
      ...found.admin,
      plan,
      planCommissions: plan === NO_PLAN ? null : { ...PLANS[plan].commissionMinor },
      planSetByAdmin: found.lifecycle.planSetByAdmin === true,
      paysForPlan: blocksNewSubscription(found.subscription, Date.now()),
    });
  } catch (e) {
    sendServerError(e, res, "In get-store-admin-settings");
  }
}
