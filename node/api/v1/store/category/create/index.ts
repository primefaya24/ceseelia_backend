// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { IN_DEV } from "../../../../../config";
import { appConstants } from "../../../../../constants";
import { isStoreCategoryPure, isStoreCategoryValid } from "../../../../../layers/core/interfaces/store";
import { createStoreCategory } from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
dotenv.config();

/*
 * Request/Response interfaces
 */
interface ReqBody {}

interface ResBody {}

/*
 * Module Route
 */
module.exports = function (router: Router): void {
  router.post("/create", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      pureRequestParams,
      validRequestParams,
      executeRouteCore,
      true,
    );
  });
};

function pureRequestParams(req: Request): boolean {
  return typeof req.body.storeId === "string" && isStoreCategoryPure(req.body.storeCategory);
}

/*
 * Ensure request params are valid
 */
function validRequestParams(req: Request): boolean {
  return req.body.storeId.length > 0 && isStoreCategoryValid(req.body.storeCategory);
}

/*
 * Route controller logic
 */
async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    // Extract params
    const storeId = req.body.storeId;
    const storeCategory = req.body.storeCategory;

    // Create category
    const categoryId: string = await createStoreCategory(storeId, storeCategory);

    // Respond to user
    res.send(categoryId);
  } catch (e) {
    if (IN_DEV) {
      console.error(e);
    }
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
