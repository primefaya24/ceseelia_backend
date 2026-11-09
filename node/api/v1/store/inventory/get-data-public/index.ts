// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { IN_DEV } from "../../../../../config";
import { appConstants } from "../../../../../constants";
import {
  getPublicStoreInventoryData,
  StoreRecordNotFoundError,
  StoreUnavailableError,
} from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import geoip from "geoip-lite";
import {
  getClientIp,
  isUlid,
  resolveCurrencyFromGeo,
} from "../../../../../layers/core/utils";
dotenv.config();

/*
 * Module Route
 */
export default function registerRoute(router: Router): void {
  router.get(
    "/get-data-public/:storeId",
    (req: Request, res: Response): void => {
      validateAndExecuteHttpApiRoute(
        req,
        res,
        pureRequestParams,
        validRequestParams,
        executeRouteCore,
        false
      );
    }
  );
};

function pureRequestParams(req: Request): boolean {
  return isUlid(req.params.storeId);
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
    // Fetch data
    const storeId = req.params["storeId"];

    const ip = getClientIp(req);
    let clientCurrency = appConstants.CURRENCY_USD;
    if (ip) {
      const geo = geoip.lookup(ip);
      clientCurrency = resolveCurrencyFromGeo(geo);
    }

    // Only what a shopper may see (2.4); 404 for an unknown or suspended store
    const storeInventoryData = await getPublicStoreInventoryData(storeId);
    if (clientCurrency && storeInventoryData.settings.currencies.length) {
      storeInventoryData.settings.currencies =
        storeInventoryData.settings.currencies.map(currency => ({
          ...currency,
          currencyIsDefault: currency.currencyCode === clientCurrency,
        }));
    }

    res.send(storeInventoryData);
  } catch (e) {
    // Both are 404s: a suspension can be lifted, so it isn't "gone" (410). The code tells them apart.
    if (e instanceof StoreRecordNotFoundError) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "STORE_NOT_FOUND", message: "Store not found" });
      return;
    }
    if (e instanceof StoreUnavailableError) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "STORE_UNAVAILABLE", message: "Store unavailable" });
      return;
    }
    if (IN_DEV) {
      console.error(e);
    }
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
