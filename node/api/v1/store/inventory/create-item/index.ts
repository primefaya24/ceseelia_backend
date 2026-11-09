// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute, STORE_ROUTES_ADMIN_ONLY } from "../../../../../layers/core/http";
import { IN_DEV, S3_STORAGE_BUCKET_NAME } from "../../../../../config";
import { appConstants } from "../../../../../constants";
import {
  isStoreItemPure,
  isStoreItemValid,
} from "../../../../../layers/core/interfaces/store";
import { StoreRecordNotFoundError, updateStoreItem } from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { deleteS3Keys, listPrefixFiles } from "../../../../../layers/aws/s3";
import { cleanUpS3Folder, isUlid, isUlidOrEmpty } from "../../../../../layers/core/utils";
dotenv.config();

/*
 * Module Route
 */
export default function registerRoute(router: Router): void {
  router.post("/create-item", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      pureRequestParams,
      validRequestParams,
      executeRouteCore,
      true,
      STORE_ROUTES_ADMIN_ONLY
    );
  });
};

function pureRequestParams(req: Request): boolean {
  return (
    isUlid(req.body.storeId) &&
    typeof req.body.isUpdate === "boolean" &&
    (req.body.isUpdate ? isUlid(req.body.storeItemId) : isUlidOrEmpty(req.body.storeItemId)) &&
    isStoreItemPure(req.body.storeItem)
  );
}

/*
 * Ensure request params are valid
 */
function validRequestParams(req: Request): boolean {
  return isStoreItemValid(
    req.body.storeItem,
    req.body.storeId,
    req.body.isUpdate ? req.body.storeItemId : undefined
  );
}

/*
 * Route controller logic
 */
async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    // Fetch data
    const storeId = req.body.storeId;
    const storeItem = req.body.storeItem;
    const storeItemId = req.body.storeItemId;
    const isUpdate = req.body.isUpdate;

    // Create item
    // On create the client's ID is ignored and a new one is generated.
    const itemId: string = await updateStoreItem(
      storeId,
      storeItem,
      isUpdate ? storeItemId : undefined,
      isUpdate
    );

    // Clean up unused images only after the write succeeded, so a failed save never deletes
    // images the stored record still uses.
    if (isUpdate) {
      await cleanUpS3Folder(
        `store/${storeId}/item/${storeItemId}/images/`,
        storeItem?.storeItemImageUris
      );
    }

    // Respond to user
    res.send(itemId);
  } catch (e) {
    if (e instanceof StoreRecordNotFoundError) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: e.message });
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
