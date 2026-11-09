// Imports
import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute, storeMember } from "../../../../../layers/core/http";
import { IN_DEV } from "../../../../../config";
import { appConstants } from "../../../../../constants";
import { MAX_COUNT } from "../../../../../constants/input-limits";
import { createImageUploads, parseUploadCount } from "../../../../../layers/aws/s3/image-upload";
import { storeChildExists } from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { isUlid } from "../../../../../layers/core/utils";

/*
 * Upload slots for an existing item's images: 1–10 in total (MAX_COUNT.itemImages); 404 if the
 * item isn't in this store (it is always created before its images are uploaded).
 * Returns a presigned POST (`{key, url, fields}`): ≤ 5 MB, fixed content type, tagged pending
 * until the record that uses it is saved (progress.md 2.3).
 */
export default function registerRoute(router: Router): void {
  router.get("/get-item-image-upload-urls/:storeId/:itemId/:pngCount/:jpgCount", (req: Request, res: Response): void => {
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
}

function pureRequestParams(req: Request): boolean {
  return isUlid(req.params.storeId) && isUlid(req.params.itemId);
}

function validRequestParams(req: Request): boolean {
  const png = parseUploadCount(req.params.pngCount);
  const jpg = parseUploadCount(req.params.jpgCount);
  return png !== null && jpg !== null && png + jpg >= 1 && png + jpg <= MAX_COUNT.itemImages;
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const { storeId } = req.params;
    const itemId = req.params.itemId;
    if (!(await storeChildExists(storeId, "Item", itemId))) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: "Item not found" });
      return;
    }
    const png = parseUploadCount(req.params.pngCount)!;
    const jpg = parseUploadCount(req.params.jpgCount)!;
    res.send(await createImageUploads(`store/${storeId}/item/${itemId}/images/`, png, jpg));
  } catch (e) {
    if (IN_DEV) {
      console.error(e);
    }
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
