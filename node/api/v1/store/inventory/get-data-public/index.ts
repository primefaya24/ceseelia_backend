// Imports
import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { sendPublicStorefront } from "../../../../../layers/core/http/public-storefront";
import { isUlid } from "../../../../../layers/core/utils";

/*
 * GET /store/inventory/get-data-public/:storeId (public, no auth). Same response as
 * GET /store/public/storefront/:slug (3.1); see sendPublicStorefront.
 */
export default function registerRoute(router: Router): void {
  router.get("/get-data-public/:storeId", (req: Request, res: Response): void => {
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

function pureRequestParams(req: Request): boolean {
  return isUlid(req.params.storeId);
}

function validRequestParams(_req: Request): boolean {
  return true;
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  await sendPublicStorefront(req, res, String(req.params.storeId));
}
