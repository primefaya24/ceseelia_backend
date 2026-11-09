// Imports
import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute, storeMember } from "../../../../layers/core/http";
import { IN_DEV } from "../../../../config";
import { appConstants } from "../../../../constants";
import { MAX_COUNT } from "../../../../constants/input-limits";
import { createImageUploads, parseUploadCount } from "../../../../layers/aws/s3/image-upload";
import { isUlid } from "../../../../layers/core/utils";

/*
 * Upload slots for promo images: 1–10 in total (MAX_COUNT.promoImages).
 * Returns a presigned POST (`{key, url, fields}`): ≤ 5 MB, fixed content type, tagged pending
 * until the record that uses it is saved (progress.md 2.3).
 */
export default function registerRoute(router: Router): void {
  router.get("/get-promo-image-upload-urls/:storeId/:pngCount/:jpgCount", (req: Request, res: Response): void => {
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
  return isUlid(req.params.storeId);
}

function validRequestParams(req: Request): boolean {
  const png = parseUploadCount(req.params.pngCount);
  const jpg = parseUploadCount(req.params.jpgCount);
  return png !== null && jpg !== null && png + jpg >= 1 && png + jpg <= MAX_COUNT.promoImages;
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const { storeId } = req.params;
    const png = parseUploadCount(req.params.pngCount)!;
    const jpg = parseUploadCount(req.params.jpgCount)!;
    res.send(await createImageUploads(`store/${storeId}/images/promo/`, png, jpg));
  } catch (e) {
    if (IN_DEV) {
      console.error(e);
    }
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
