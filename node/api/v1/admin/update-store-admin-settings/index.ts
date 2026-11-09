import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { NUMBER_RANGE } from "../../../../constants/input-limits";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { isUlid } from "../../../../layers/core/utils";
import {
  StoreRecordNotFoundError,
  updateStoreAdminSettings,
} from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { sendServerError } from "../route-errors";

/*
 * PUT /admin/update-store-admin-settings (admin, progress.md 1.6)
 * Body: { storeId, salesCommission, isStoreLive } → the saved { salesCommission, isStoreLive }
 * 404 STORE_NOT_FOUND. Merchants can't change these: update-settings never writes `admin`.
 */
export default function registerRoute(router: Router): void {
  router.put("/update-store-admin-settings", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore, true, /* admins only */ true);
  });
}

function pureRequestParams(req: Request): boolean {
  const { storeId, salesCommission, isStoreLive } = req.body;
  return isUlid(storeId) && typeof salesCommission === "number" && typeof isStoreLive === "boolean";
}

function validRequestParams(req: Request): boolean {
  const { salesCommission } = req.body;
  const { min, max } = NUMBER_RANGE.salesCommission;
  return Number.isFinite(salesCommission) && salesCommission >= min && salesCommission <= max;
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const { storeId, salesCommission, isStoreLive } = req.body;
    res.send(await updateStoreAdminSettings(storeId, { salesCommission, isStoreLive }));
  } catch (e) {
    if (e instanceof StoreRecordNotFoundError) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: "Store not found", code: "STORE_NOT_FOUND" });
      return;
    }
    sendServerError(e, res, "In update-store-admin-settings");
  }
}
