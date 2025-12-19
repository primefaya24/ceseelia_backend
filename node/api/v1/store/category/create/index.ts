// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { IN_DEV, S3_STORAGE_BUCKET_NAME } from "../../../../../config";
import { appConstants } from "../../../../../constants";
import {
  isStoreCategoryPure,
  isStoreCategoryValid,
} from "../../../../../layers/core/interfaces/store";
import { updateStoreCategory } from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { deleteS3Keys, listPrefixFiles } from "../../../../../layers/aws/s3";
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
      true
    );
  });
};

function pureRequestParams(req: Request): boolean {
  return (
    typeof req.body.storeId === "string" &&
    typeof req.body.isUpdate === "boolean" &&
    isStoreCategoryPure(req.body.storeCategory)
  );
}

/*
 * Ensure request params are valid
 */
function validRequestParams(req: Request): boolean {
  return (
    req.body.storeId.length > 0 && isStoreCategoryValid(req.body.storeCategory)
  );
}

/*
 * Route controller logic
 */
async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    // Extract params
    const storeId = req.body.storeId;
    const storeCategory = req.body.storeCategory;
    const storeCategoryId = req.body.categoryId;
    const isUpdate = req.body.isUpdate;

    // Fetch current s3 image objects
    if (isUpdate) {
      const currentS3Uris: string[] = (await listPrefixFiles(
        S3_STORAGE_BUCKET_NAME,
        `store/${storeId}/category/${storeCategoryId}/images/`
      ))
        .map(o => o.Key)
        .filter((key): key is string => typeof key === "string");

      const bannerUri = storeCategory?.storeCategoryBannerUri || "";
      const keysToDelete =
        bannerUri.length === 0
          ? currentS3Uris
          : currentS3Uris.filter(key => key !== bannerUri);

      if (keysToDelete.length > 0) {
        await deleteS3Keys(S3_STORAGE_BUCKET_NAME, keysToDelete);
      }
    }

    // Create category
    const categoryId: string = await updateStoreCategory(
      storeId,
      storeCategory,
      storeCategoryId
    );

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
