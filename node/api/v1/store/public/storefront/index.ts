// Imports
import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { IN_DEV } from "../../../../../config";
import { appConstants } from "../../../../../constants";
import { isValidSlug } from "../../../../../constants/slug";
import { getSlugOwner } from "../../../../../layers/aws/dynamodb/dynamo-entities/slug";
import { sendPublicStorefront, storeNotFound } from "../../../../../layers/core/http/public-storefront";

/*
 * GET /store/public/storefront/:slug (public, no auth; progress.md 3.1 / WA 3.1)
 * The slug → storeId lookup (1.8) and the public storefront data (2.4) in one request:
 * { storeId, settings, categories, items }. The slug is lowercased first. 404 STORE_NOT_FOUND
 * for an unknown slug or store, 404 STORE_UNAVAILABLE for a suspended one.
 */
export default function registerRoute(router: Router): void {
  router.get("/storefront/:slug", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      pureRequestParams,
      validRequestParams,
      executeRouteCore,
      false
    );
  });
}

const slugParam = (req: Request): string => String(req.params.slug).toLowerCase();

function pureRequestParams(req: Request): boolean {
  return typeof req.params.slug === "string";
}

function validRequestParams(req: Request): boolean {
  return isValidSlug(slugParam(req));
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  let storeId: string | null;
  try {
    storeId = await getSlugOwner(slugParam(req));
  } catch (e) {
    if (IN_DEV) console.error(e);
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
    return;
  }
  if (!storeId) {
    storeNotFound(res);
    return;
  }
  await sendPublicStorefront(req, res, storeId);
}
