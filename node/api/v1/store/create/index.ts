// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { S3_STORAGE_BUCKET_NAME } from "../../../../config";
import { appConstants } from "../../../../constants";
import { MAX_LENGTH } from "../../../../constants/input-limits";
import { createStore } from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { StoreOverview } from "../../../../layers/core/interfaces/store";
import { listPrefixFiles } from "../../../../layers/aws/s3";
import { isValidSlug } from "../../../../constants/slug";
import { SlugTakenError } from "../../../../layers/aws/dynamodb/dynamo-entities/slug";
import { log } from "../../../../layers/core/logger";
import { isCurrencyCode } from "../../merchant/create-store";
import { shopperCurrency } from "../../../../layers/core/http/public-storefront";
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
  router.post("/create", (req: Request, res: Response): void => {
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

function pureRequestParams(req: Request): boolean {
  return (
    typeof req.body.storeName === "string" &&
    typeof req.body.storeSlug === "string" &&
    (req.body.currencyCode === undefined || typeof req.body.currencyCode === "string")
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
    isValidSlug(storeSlug) &&
    (req.body.currencyCode === undefined || isCurrencyCode(req.body.currencyCode))
  );
}

/*
 * Route controller logic
 */
async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    // Extract params
    const storeName = req.body.storeName;
    const storeSlug = req.body.storeSlug;

    // Create store
    // T.3c: the currency the admin picked, else the one for where they are.
    const storeOverview: StoreOverview = await createStore(
      storeName,
      storeSlug,
      undefined,
      req.body.currencyCode ?? shopperCurrency(req)
    );

    // Respond to user
    res.send(storeOverview);
  } catch (e) {
    if (e instanceof SlugTakenError) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ message: e.message });
      return;
    }
    log.error({ err: e }, "In store/create");
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
