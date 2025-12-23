// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { IN_DEV, S3_STORAGE_BUCKET_NAME } from "../../../../../config";
import { appConstants } from "../../../../../constants";
import {
  isStoreItemPure,
  isStoreItemValid,
} from "../../../../../layers/core/interfaces/store";
import { updateStoreItem } from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { deleteS3Keys, listPrefixFiles } from "../../../../../layers/aws/s3";
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
    typeof req.body.storeId === "string" &&
    typeof req.body.isUpdate === "boolean" &&
    isStoreItemPure(req.body.storeItem)
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
    const storeItemId = req.body.storeItemId;
    const isUpdate = req.body.isUpdate;

    // Fetch current s3 image objects
    if (isUpdate) {
      const currentS3Uris: string[] = (
        await listPrefixFiles(
          S3_STORAGE_BUCKET_NAME,
          `store/${storeId}/item/${storeItemId}/images/`
        )
      )
        .map((o) => o.Key)
        .filter((key): key is string => typeof key === "string");

      const imageInputUris = Array.isArray(storeItem?.storeItemImageUris)
        ? new Set(
            storeItem.storeItemImageUris.filter(
              (uri: unknown): uri is string => typeof uri === "string"
            )
          )
        : new Set<string>();
      const keysToDelete: string[] = currentS3Uris.filter(
        (key) => !imageInputUris.has(key)
      );

      if (keysToDelete.length > 0) {
        await deleteS3Keys(S3_STORAGE_BUCKET_NAME, keysToDelete);
      }
    }

    // Create item
    const itemId: string = await updateStoreItem(
      storeId,
      storeItem,
      storeItemId
    );

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
