// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { IN_DEV, S3_STORAGE_BUCKET_NAME } from "../../../../../config";
import { appConstants } from "../../../../../constants";
import { getUploadSignedUrl } from "../../../../../layers/aws/s3";
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
    "/get-image-upload-urls/:storeId/:itemId/:pngCount/:jpgCount",
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
    const itemId = req.params.itemId;
    const pngCount = Number(req.params.pngCount);
    const jpgCount = Number(req.params.jpgCount);

    const parseCount = (count: number): number => {
      if (!Number.isFinite(count) || count <= 0) {
        return 0;
      }
      return Math.floor(count);
    };

    const createSignedUpload = async (
      imageType: "png" | "jpg"
    ): Promise<{ key: string; url: string; imageType: "png" | "jpg" }> => {
      const key = `store/${storeId}/item/${itemId}/images/${ULID.ulid()}.${imageType}`;
      const url = await getUploadSignedUrl(
        S3_STORAGE_BUCKET_NAME,
        key,
        `image/${imageType}`
      );
      return { key, url, imageType };
    };

    const uploadPromises = [
      ...Array.from({ length: parseCount(pngCount) }, () =>
        createSignedUpload("png")
      ),
      ...Array.from({ length: parseCount(jpgCount) }, () =>
        createSignedUpload("jpg")
      ),
    ];
    const imageAssets = await Promise.all(uploadPromises);

    const groupedUploads = imageAssets.reduce(
      (
        acc: {
          png: Array<{ key: string; url: string }>;
          jpg: Array<{ key: string; url: string }>;
        },
        asset
      ) => {
        const { imageType, ...upload } = asset;
        acc[imageType].push(upload);
        return acc;
      },
      { png: [], jpg: [] }
    );

    // Respond to user
    res.send(groupedUploads);
  } catch (e) {
    if (IN_DEV) {
      console.error(e);
    }
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
