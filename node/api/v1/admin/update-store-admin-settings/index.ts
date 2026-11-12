import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { isUlid } from "../../../../layers/core/utils";
import { isSalesCommissionsValid } from "../../../../layers/core/interfaces/store";
import {
  StoreRecordNotFoundError,
  updateStoreAdminSettings,
} from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { sendServerError } from "../route-errors";

/*
 * PUT /admin/update-store-admin-settings (admin, progress.md 1.6)
 * Body: { storeId, salesCommissions, isStoreLive } → the saved { salesCommissions, isStoreLive }
 * salesCommissions: whole cents for every currency, e.g. { USD: 125, CAD: 125, AUD: 125 } (5.1a).
 * 404 STORE_NOT_FOUND. Merchants can't change these: update-settings never writes `admin`.
 */
export default function registerRoute(router: Router): void {
  router.put("/update-store-admin-settings", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore, true, /* admins only */ true);
  });
}

function pureRequestParams(req: Request): boolean {
  const { storeId, salesCommissions, isStoreLive } = req.body;
  return isUlid(storeId) && typeof salesCommissions === "object" && typeof isStoreLive === "boolean";
}

function validRequestParams(req: Request): boolean {
  return isSalesCommissionsValid(req.body.salesCommissions);
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const { storeId, salesCommissions, isStoreLive } = req.body;
    const { USD, CAD, AUD } = salesCommissions;
    res.send(await updateStoreAdminSettings(storeId, { salesCommissions: { USD, CAD, AUD }, isStoreLive }));
  } catch (e) {
    if (e instanceof StoreRecordNotFoundError) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: "Store not found", code: "STORE_NOT_FOUND" });
      return;
    }
    sendServerError(e, res, "In update-store-admin-settings");
  }
}
