// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { IN_DEV, S3_STORAGE_BUCKET_NAME } from "../../../../config";
import { appConstants } from "../../../../constants";
import {
  isStoreSettingsPure,
  isStoreSettingsValid,
  StoreSettings,
} from "../../../../layers/core/interfaces/store";
import { updateStoreSettings } from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { deleteS3Keys, listPrefixFiles } from "../../../../layers/aws/s3";
import {
  cleanUpS3Folder,
  extractStoreHeaderStripImageUri,
  extractStorePromoImageUris,
} from "../../../../layers/core/utils";
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
  router.put("/update-settings", (req: Request, res: Response): void => {
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

/*
 * Ensure request params are pure
 */
function pureRequestParams(req: Request): boolean {
  return (
    typeof req.body.storeId === "string" &&
    isStoreSettingsPure(req.body.storeSettings)
  );
}

/*
 * Ensure request params are valid
 */
function validRequestParams(req: Request): boolean {
  return (
    req.body.storeId.length > 0 && isStoreSettingsValid(req.body.storeSettings)
  );
}

/*
 * Route controller logic
 */
async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    // Extract params
    const storeId = req.body.storeId;
    const storeSettings = req.body.storeSettings;

    // Clean up s3 leaks - store logo
    await cleanUpS3Folder(`store/${storeId}/images/logo/`, [
      storeSettings?.storeInfo?.logoUri || "",
    ]);

    // Clean up s3 leaks - store header strip
    await cleanUpS3Folder(`store/${storeId}/images/header/`, [
      extractStoreHeaderStripImageUri(storeSettings),
    ]);

    // Clean up s3 leaks - store promos
    await cleanUpS3Folder(
      `store/${storeId}/images/promo/`,
      extractStorePromoImageUris(storeSettings as StoreSettings)
    );

    // Update settings
    updateStoreSettings(storeId, storeSettings);

    // Respond to user
    res.send();
  } catch (e) {
    if (IN_DEV) {
      console.error(e);
    }
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
