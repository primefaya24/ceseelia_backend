import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { isUlid } from "../../../../layers/core/utils";
import {
  COMMISSION_MODES,
  COMMISSION_SOURCES,
  isCommissionPercentBpsValid,
  isSalesCommissionsValid,
} from "../../../../layers/core/interfaces/store";
import {
  StoreRecordNotFoundError,
  updateStoreAdminSettings,
} from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { sendServerError } from "../route-errors";

/*
 * PUT /admin/update-store-admin-settings (admin, progress.md 1.6)
 * Body: { storeId, commissionSource, commissionMode, commissionPercentBps, salesCommissions,
 * suspended } → the saved block (same fields without storeId). All fields are required:
 * - commissionSource: "PLAN" (the store's plan's default fee) | "CUSTOM" (the fields below; P.6).
 *   The custom fields are saved either way, so switching back to CUSTOM restores them.
 * - commissionMode: "FIXED" | "PERCENT".
 * - commissionPercentBps: basis points 0–3,000 (250 = 2.5%), whole number; kept in FIXED mode too.
 * - salesCommissions: whole cents for every currency, e.g. { USD: 125, CAD: 125, AUD: 125 } (5.1a):
 *   the fee in FIXED mode, the per-order minimum in PERCENT mode.
 * 404 STORE_NOT_FOUND. Merchants can't change these: update-settings never writes `admin`.
 */
export default function registerRoute(router: Router): void {
  router.put("/update-store-admin-settings", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore, true, /* admins only */ true);
  });
}

function pureRequestParams(req: Request): boolean {
  const { storeId, commissionSource, commissionMode, commissionPercentBps, salesCommissions, suspended } = req.body;
  return (
    isUlid(storeId) &&
    typeof commissionSource === "string" &&
    typeof commissionMode === "string" &&
    typeof commissionPercentBps === "number" &&
    typeof salesCommissions === "object" &&
    typeof suspended === "boolean"
  );
}

function validRequestParams(req: Request): boolean {
  const { commissionSource, commissionMode, commissionPercentBps, salesCommissions } = req.body;
  return (
    (COMMISSION_SOURCES as readonly string[]).includes(commissionSource) &&
    (COMMISSION_MODES as readonly string[]).includes(commissionMode) &&
    isCommissionPercentBpsValid(commissionPercentBps) &&
    isSalesCommissionsValid(salesCommissions)
  );
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const { storeId, commissionSource, commissionMode, commissionPercentBps, salesCommissions, suspended } = req.body;
    const { USD, CAD, AUD } = salesCommissions;
    res.send(
      await updateStoreAdminSettings(storeId, {
        commissionSource,
        commissionMode,
        commissionPercentBps,
        salesCommissions: { USD, CAD, AUD },
        suspended,
      })
    );
  } catch (e) {
    if (e instanceof StoreRecordNotFoundError) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: "Store not found", code: "STORE_NOT_FOUND" });
      return;
    }
    sendServerError(e, res, "In update-store-admin-settings");
  }
}
