// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute, storeMember } from "../../../../../layers/core/http";
import { S3_STORAGE_BUCKET_NAME } from "../../../../../config";
import { appConstants } from "../../../../../constants";
import {
  isStoreItemPure,
  isStoreItemValid,
} from "../../../../../layers/core/interfaces/store";
import { withVariantTotals } from "../../../../../layers/core/variants";
import { listStoreParams, StoreRecordNotFoundError, updateStoreItem } from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { syncItemParams, UnknownStoreParamError } from "../../../../../layers/core/store-params";
import { deleteS3Keys, listPrefixFiles } from "../../../../../layers/aws/s3";
import { cleanUpS3Folder, isUlid, isUlidOrEmpty } from "../../../../../layers/core/utils";
import { markImagesKept } from "../../../../../layers/aws/s3/image-upload";
import { queueItemCheck } from "../../../../../layers/aws/dynamodb/dynamo-entities/item-review";
import { ITEM_CHECK_DELAY_MS } from "../../../../../layers/core/store-validation/item-check";
import { log } from "../../../../../layers/core/logger";
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
      storeMember((req) => req.body.storeId)
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
 * Ensure request params are valid. The item is first put in its saved shape (2.7): trimmed
 * labels, variant params required, and a variant item's stock and prices worked out from its
 * rows, never taken from the client. That shape is what gets validated and saved.
 */
function validRequestParams(req: Request): boolean {
  req.body.storeItem = withVariantTotals(req.body.storeItem);
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
    let storeItem = req.body.storeItem;
    const storeItemId = req.body.storeItemId;
    const isUpdate = req.body.isUpdate;

    // Stage R (R.4): linked params are written from the store's parameters, never from the
    // client (it only picks which ones and their order). Then the saved shape is checked again.
    if ((storeItem.storeItemCustomParams ?? []).some((p: { storeParamId?: string }) => p.storeParamId !== undefined)) {
      try {
        storeItem = withVariantTotals(syncItemParams(storeItem, await listStoreParams(storeId)));
      } catch (e) {
        if (!(e instanceof UnknownStoreParamError)) throw e;
        res.status(appConstants.HTTP_STATUS_CODE_BAD_REQUEST).send({ code: "PARAM_NOT_FOUND", message: "A parameter on this item no longer exists. Reload and try again." });
        return;
      }
      const ids = storeItem.storeItemCustomParams.map((p: { storeParamId?: string }) => p.storeParamId).filter(Boolean);
      if (new Set(ids).size !== ids.length || !isStoreItemValid(storeItem, storeId, isUpdate ? storeItemId : undefined)) {
        res.status(appConstants.HTTP_STATUS_CODE_BAD_REQUEST).send({ message: appConstants.HTTP_ERROR_MSG_INVALID_REQUEST_PARAMS });
        return;
      }
    }

    // Keep the images this save uses (clear their pending tag, 2.3d) before saving them
    await markImagesKept(storeItem?.storeItemImageUris ?? []);

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

    // L.2: the AI check looks at it a few minutes after the last save (only on a live store;
    // the sweep skips drafts, and saves that change nothing it reads). Never fails the save.
    await queueItemCheck(storeId, itemId, ITEM_CHECK_DELAY_MS).catch((e) =>
      log.error({ err: e }, `[item check] couldn't queue item ${itemId}`)
    );

    // Respond to user
    res.send(itemId);
  } catch (e) {
    if (e instanceof StoreRecordNotFoundError) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: e.message });
      return;
    }
    log.error({ err: e }, "In store/inventory/create-item");
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
