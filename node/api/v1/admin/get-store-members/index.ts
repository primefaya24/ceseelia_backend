import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { isUlid } from "../../../../layers/core/utils";
import {
  getStoreOverviewRow,
  listStoreInvites,
  listStoreMembers,
} from "../../../../layers/aws/dynamodb/dynamo-entities/membership";
import { sendServerError } from "../membership-errors";

/*
 * GET /admin/get-store-members/:storeId (admin, progress.md 1.4a)
 * → { members: StoreMemberView[], invites: StoreInvite[] }
 */
export default function registerRoute(router: Router): void {
  router.get("/get-store-members/:storeId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureRequestParams, () => true, executeRouteCore, true, /* admins only */ true);
  });
}

function pureRequestParams(req: Request): boolean {
  return isUlid(req.params.storeId);
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const storeId = req.params.storeId as string;
    if (!(await getStoreOverviewRow(storeId))) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: "Store not found", code: "STORE_NOT_FOUND" });
      return;
    }
    const [members, invites] = await Promise.all([listStoreMembers(storeId), listStoreInvites(storeId)]);
    res.send({ members, invites });
  } catch (e) {
    sendServerError(e, res, "In get-store-members");
  }
}
