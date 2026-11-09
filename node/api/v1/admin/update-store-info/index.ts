// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { IN_DEV } from "../../../../config";
import { appConstants } from "../../../../constants";
import { MAX_LENGTH } from "../../../../constants/input-limits";
import { updateStoreInfo } from "../../../../layers/aws/dynamodb/dynamo-entities/admin";
import { StoreOverview } from "../../../../layers/core/interfaces/store";
import { isUlid } from "../../../../layers/core/utils";
import { isValidSlug } from "../../../../constants/slug";
import { SlugTakenError } from "../../../../layers/aws/dynamodb/dynamo-entities/slug";
import { StoreRecordNotFoundError } from "../../../../layers/aws/dynamodb/dynamo-entities/store";
dotenv.config();

/*
 * Request/Response interfaces
 */
interface ReqBody {}

interface ResBody {}

/*
 * Module Route
 */
export default function registerRoute(router: Router): void {
  router.post("/update-store-info", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      pureRequestParams,
      validRequestParams,
      executeRouteCore,
      true,
      true
    );
  });
};

/*
 * Ensure request params are pure
 */
function pureRequestParams(req: Request): boolean {
  return (
    isUlid(req.body.storeId) &&
    typeof req.body.storeName === "string" &&
    typeof req.body.storeSlug === "string"
  );
}

/*
 * Ensure request params are valid
 */
function validRequestParams(req: Request): boolean {
  const { storeName, storeSlug } = req.body;
  return (
    storeName.trim().length > 0 &&
    storeName.length <= MAX_LENGTH.storeName &&
    isValidSlug(storeSlug)
  );
}

/*
 * Route controller logic
 */
async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    // Extract params
    const storeId = req.body.storeId;
    const storeName = req.body.storeName;
    const storeSlug = req.body.storeSlug;

    // Update store info
    const storeOverview: StoreOverview = await updateStoreInfo(storeId, storeName, storeSlug);

    // Respond to user
    res.send(storeOverview);
  } catch (e) {
    if (e instanceof SlugTakenError) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ message: e.message });
      return;
    }
    if (e instanceof StoreRecordNotFoundError) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: "Store not found" });
      return;
    }
    if (IN_DEV) {
      console.error(e);
    }
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
