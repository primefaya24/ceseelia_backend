// Imports
import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { IN_DEV } from "../../../../../config";
import { appConstants } from "../../../../../constants";
import { isValidSlug } from "../../../../../constants/slug";
import { getSlugOwner } from "../../../../../layers/aws/dynamodb/dynamo-entities/slug";
import { CACHE_CONTROL, setCacheControl } from "../../../../../layers/core/http/cache";

/*
 * GET /store/public/resolve-slug/:slug → { storeId } (public, no auth; progress.md 1.8 / WA 3.1)
 * The slug is lowercased first, so /s/Northern-Hoop works. 404 when no store holds it.
 * Whether the store is live is not checked here; the storefront data endpoint does that (2.4).
 */
export default function registerRoute(router: Router): void {
  router.get("/resolve-slug/:slug", (req: Request, res: Response): void => {
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
  try {
    const storeId = await getSlugOwner(slugParam(req));
    if (!storeId) {
      setCacheControl(res, CACHE_CONTROL.none);
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: "Store not found" });
      return;
    }
    setCacheControl(res, CACHE_CONTROL.slug);
    res.send({ storeId });
  } catch (e) {
    if (IN_DEV) {
      console.error(e);
    }
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
