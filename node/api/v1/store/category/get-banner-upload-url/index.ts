// Imports
import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute, storeMember } from "../../../../../layers/core/http";
import { IN_DEV } from "../../../../../config";
import { appConstants } from "../../../../../constants";
import { createImageUpload, parseImageType } from "../../../../../layers/aws/s3/image-upload";
import { storeChildExists } from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { isUlid } from "../../../../../layers/core/utils";

/*
 * Upload slot for an existing category's banner; 404 if the category isn't in this store.
 * Returns a presigned POST (`{key, url, fields}`): ≤ 5 MB, fixed content type, tagged pending
 * until the record that uses it is saved (progress.md 2.3).
 */
export default function registerRoute(router: Router): void {
  router.get("/get-banner-upload-url/:storeId/:categoryId/:imageType", (req: Request, res: Response): void => {
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
  return isUlid(req.params.storeId) && isUlid(req.params.categoryId);
}

function validRequestParams(req: Request): boolean {
  return parseImageType(req.params.imageType) !== null;
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const { storeId, categoryId } = req.params;
    if (!(await storeChildExists(storeId, "Category", categoryId))) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: "Category not found" });
      return;
    }
    const imageType = parseImageType(req.params.imageType)!;
    res.send(await createImageUpload(`store/${storeId}/category/${categoryId}/images/`, imageType));
  } catch (e) {
    if (IN_DEV) {
      console.error(e);
    }
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
