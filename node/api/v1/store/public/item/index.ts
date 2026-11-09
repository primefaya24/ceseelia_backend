// Imports
import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { appConstants } from "../../../../../constants";
import { getPublicStoreItem } from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import {
  sendPublicError,
  shopperCurrency,
  withShopperCurrency,
} from "../../../../../layers/core/http/public-storefront";
import { CACHE_CONTROL, setCacheControl } from "../../../../../layers/core/http/cache";
import { isUlid } from "../../../../../layers/core/utils";

/*
 * GET /store/public/item/:storeId/:itemId (public, no auth; progress.md 3.3 / WA 3.5)
 * One item for a deep link: { storeId, item, category, currencies }, with the same rules as the
 * storefront (2.4/2.5) and the shopper's currency as default when offered. 404 ITEM_NOT_FOUND for
 * a missing or hidden item (hidden ones look missing on purpose), and the store's 404s otherwise.
 */
export default function registerRoute(router: Router): void {
  router.get("/item/:storeId/:itemId", (req: Request, res: Response): void => {
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
  return isUlid(req.params.storeId) && isUlid(req.params.itemId);
}

function validRequestParams(_req: Request): boolean {
  return true;
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  const storeId = String(req.params.storeId);
  try {
    const found = await getPublicStoreItem(storeId, String(req.params.itemId));
    if (!found) {
      setCacheControl(res, CACHE_CONTROL.none);
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "ITEM_NOT_FOUND", message: "Item not found" });
      return;
    }
    setCacheControl(res, CACHE_CONTROL.storefront);
    res.send({
      storeId,
      item: found.item,
      category: found.category,
      currencies: withShopperCurrency(found.settings.currencies, shopperCurrency(req)),
    });
  } catch (e) {
    sendPublicError(res, e);
  }
}
