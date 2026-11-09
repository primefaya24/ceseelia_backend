// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute, storeMember } from "../../../../../layers/core/http";
import { IN_DEV } from "../../../../../config";
import { appConstants } from "../../../../../constants";
import { getStoreInventoryData } from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { isUlid } from "../../../../../layers/core/utils";
dotenv.config();

/*
 * Module Route
 */
export default function registerRoute(router: Router): void {
  router.get("/get-data/:storeId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      pureRequestParams,
      validRequestParams,
      executeRouteCore,
      true,
      storeMember((req) => req.params.storeId)
    );
  });
};

function pureRequestParams(req: Request): boolean {
  return isUlid(req.params.storeId);
}

/*
 * Ensure request params are valid
 */
function validRequestParams(req: Request): boolean {
  return true;
}

/*
 * Route controller logic
 */
async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    // Fetch data
    const storeId = req.params["storeId"];

    // Fetch store inventory data
    const storeInventoryData = await getStoreInventoryData(storeId);

    // Respond to user
    res.send(storeInventoryData);
  } catch (e) {
    if (IN_DEV) {
      console.error(e);
    }
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
