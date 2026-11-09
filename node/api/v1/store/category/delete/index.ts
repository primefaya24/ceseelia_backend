// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute, storeMember } from "../../../../../layers/core/http";
import { IN_DEV, S3_STORAGE_BUCKET_NAME } from "../../../../../config";
import { appConstants } from "../../../../../constants";
import { deleteS3Keys, listPrefixFiles } from "../../../../../layers/aws/s3";
import { CategoryNotEmptyError, deleteStoreCategory } from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { isUlid } from "../../../../../layers/core/utils";
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
  router.delete("/delete/:storeId/:storeCategoryId", (req: Request, res: Response): void => {
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
  return isUlid(req.params.storeId) && isUlid(req.params.storeCategoryId);
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
    const storeCategoryId = req.params.storeCategoryId;

    // The category first (refused while it has items, 2.2); its banner only once it's gone.
    await deleteStoreCategory(storeId, storeCategoryId);

    const currentS3Uris: string[] = (
      await listPrefixFiles(S3_STORAGE_BUCKET_NAME, `store/${storeId}/category/${storeCategoryId}/`)
    )
      .map((o) => o.Key)
      .filter((key): key is string => typeof key === "string");
    if (currentS3Uris.length > 0) {
      await deleteS3Keys(S3_STORAGE_BUCKET_NAME, currentS3Uris);
    }

    // Respond to user
    res.send({});
  } catch (e) {
    if (e instanceof CategoryNotEmptyError) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({
        code: "CATEGORY_NOT_EMPTY",
        message: e.message,
        itemCount: e.itemCount,
      });
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
