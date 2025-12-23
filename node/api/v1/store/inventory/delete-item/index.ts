// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { IN_DEV, S3_STORAGE_BUCKET_NAME } from "../../../../../config";
import { appConstants } from "../../../../../constants";
import { deleteS3Keys, listPrefixFiles } from "../../../../../layers/aws/s3";
import {
  deleteStoreCategory,
  deleteStoreItem,
} from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
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
  router.delete(
    "/delete-item/:storeId/:storeItemId",
    (req: Request, res: Response): void => {
      validateAndExecuteHttpApiRoute(
        req,
        res,
        pureRequestParams,
        validRequestParams,
        executeRouteCore,
        true
      );
    }
  );
};

function pureRequestParams(req: Request): boolean {
  return true;
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
    // Extract params
    const storeId = req.params.storeId;
    const storeItemId = req.params.storeItemId;

    // Delete category photos if any
    const currentS3Uris: string[] = (
      await listPrefixFiles(
        S3_STORAGE_BUCKET_NAME,
        `store/${storeId}/item/${storeItemId}/`
      )
    )
      .map((o) => o.Key)
      .filter((key): key is string => typeof key === "string");
    if (currentS3Uris.length > 0) {
      await deleteS3Keys(S3_STORAGE_BUCKET_NAME, currentS3Uris);
    }

    // Delete category
    await deleteStoreItem(storeId, storeItemId);

    // Respond to user
    res.send({});
  } catch (e) {
    if (IN_DEV) {
      console.error(e);
    }
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
