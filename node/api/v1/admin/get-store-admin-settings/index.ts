import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { isUlid } from "../../../../layers/core/utils";
import { getStoreAdminSettings } from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { sendServerError } from "../route-errors";

/*
 * GET /admin/get-store-admin-settings/:storeId (admin, progress.md 1.6)
 * → { salesCommissions, isStoreLive } (minor units per currency, 5.1a) · 404 STORE_NOT_FOUND
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
    const admin = await getStoreAdminSettings(req.params.storeId as string);
    if (!admin) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: "Store not found", code: "STORE_NOT_FOUND" });
      return;
    }
    res.send(admin);
  } catch (e) {
    sendServerError(e, res, "In get-store-admin-settings");
  }
}
