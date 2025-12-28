// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { IN_DEV, S3_STORAGE_BUCKET_NAME } from "../../../../config";
import { appConstants } from "../../../../constants";
import { getUploadSignedUrl } from "../../../../layers/aws/s3";
dotenv.config();
const ULID = require("ulid");

/*
 * Request/Response interfaces
 */
interface ReqBody {}

interface ResBody {}

/*
 * Module Route
 */
module.exports = function (router: Router): void {
  router.get(
    "/get-logo-upload-url/:storeId/:imageType",
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
  return (
    req.params.imageType === "png" ||
    req.params.imageType === "jpg" ||
    req.params.imageType === "jpeg"
  );
}

/*
 * Route controller logic
 */
async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    // Extract params
    const storeId = req.params.storeId;
    const imageType = req.params.imageType;

    // Create upload signed url
    const imageAsset = {
      key: `store/${storeId}/images/logo/${ULID.ulid()}.${imageType}`,
      url: "",
    };
    imageAsset.url = await getUploadSignedUrl(
      S3_STORAGE_BUCKET_NAME,
      imageAsset.key,
      `image/${imageType}`
    );

    // Respond to user
    res.send(imageAsset);
  } catch (e) {
    if (IN_DEV) {
      console.error(e);
    }
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
