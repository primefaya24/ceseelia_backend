import { Request, Response } from "express";
import geoip from "geoip-lite";

import { IN_DEV } from "../../../config";
import { appConstants } from "../../../constants";
import {
  getPublicStoreInventoryData,
  StoreRecordNotFoundError,
  StoreUnavailableError,
} from "../../aws/dynamodb/dynamo-entities/store";
import { StoreCurrency, StoreInventoryData } from "../interfaces/store";
import { getClientIp, resolveCurrencyFromGeo } from "../utils";

export type PublicStorefront = StoreInventoryData & { storeId: string };

/*
 * Make the shopper's currency (from their location) the default, but only if the store offers it;
 * otherwise the store's own default stays. Before 3.1 a store without the shopper's currency was
 * left with no default at all, and the storefront showed no prices.
 */
export function withShopperCurrency(currencies: StoreCurrency[], shopperCode: string): StoreCurrency[] {
  if (!currencies.some((c) => c.currencyCode === shopperCode)) return currencies;
  return currencies.map((c) => ({ ...c, currencyIsDefault: c.currencyCode === shopperCode }));
}

export const storeNotFound = (res: Response): void => {
  res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "STORE_NOT_FOUND", message: "Store not found" });
};

/*
 * The public storefront response, shared by GET /store/inventory/get-data-public/:storeId and
 * GET /store/public/storefront/:slug (3.1): only what a shopper may see (2.4), the shopper's
 * currency as default when offered, and the storeId (the cart and contact form need it).
 * 404 STORE_NOT_FOUND / STORE_UNAVAILABLE; both are 404 because a suspension can be lifted.
 */
export async function sendPublicStorefront(req: Request, res: Response, storeId: string): Promise<void> {
  try {
    const data = await getPublicStoreInventoryData(storeId);
    const ip = getClientIp(req);
    const shopperCode = ip ? resolveCurrencyFromGeo(geoip.lookup(ip)) : appConstants.CURRENCY_USD;
    const body: PublicStorefront = {
      storeId,
      ...data,
      settings: { ...data.settings, currencies: withShopperCurrency(data.settings.currencies, shopperCode) },
    };
    res.send(body);
  } catch (e) {
    if (e instanceof StoreRecordNotFoundError) {
      storeNotFound(res);
      return;
    }
    if (e instanceof StoreUnavailableError) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "STORE_UNAVAILABLE", message: "Store unavailable" });
      return;
    }
    if (IN_DEV) console.error(e);
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
