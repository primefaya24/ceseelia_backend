// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { IN_DEV } from "../../../../../config";
import { appConstants } from "../../../../../constants";
import {
  isStoreItemPure,
  isStoreItemValid,
} from "../../../../../layers/core/interfaces/store";
import { createStoreItem } from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
dotenv.config();

/*
 * Module Route
 */
module.exports = function (router: Router): void {
  router.post("/create-item", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      pureRequestParams,
      validRequestParams,
      executeRouteCore,
      true
    );
  });
};

function pureRequestParams(req: Request): boolean {
  return (
    typeof req.body.storeId === "string" && isStoreItemPure(req.body.storeItem)
  );
}

/*
 * Ensure request params are valid
 */
function validRequestParams(req: Request): boolean {
  return req.body.storeId.length > 0 && isStoreItemValid(req.body.storeItem);
}

/*
 * Route controller logic
 */
async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    // Fetch data
    const storeId = req.body.storeId;
    const storeItem = req.body.storeItem;

    // Create item
    const itemId: string = await createStoreItem(storeId, storeItem);

    // Respond to user
    res.send(itemId);
  } catch (e) {
    if (IN_DEV) {
      console.error(e);
    }
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
