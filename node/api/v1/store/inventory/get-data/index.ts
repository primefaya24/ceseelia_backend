// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { getAuth, validateAndExecuteHttpApiRoute, storeMember } from "../../../../../layers/core/http";
import { appConstants } from "../../../../../constants";
import { getStoreInventoryData, withoutAdminSettings } from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { isUlid } from "../../../../../layers/core/utils";
import { StoreInventoryData } from "../../../../../layers/core/interfaces/store";
import { log } from "../../../../../layers/core/logger";
import { currentFxRates } from "../../../../../layers/core/fx";
dotenv.config();

/*
 * Module Route
 */
export default function registerRoute(router: Router): void {
  router.get("/get-data/:storeId", (req: Request, res: Response): void => {
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

    // Fetch store inventory data. The admin block (commission, store live) is for admins only
    // (progress.md 1.6); they edit it in Admin › Stores.
    const storeInventoryData = await getStoreInventoryData(storeId, { withParams: true });

    // Respond to user
    // L.2: merchants see that an item is hidden and why in general terms, never the reasons.
    // T.4: today's rates, so the editor can show the automatic prices in the other currencies
    // (null until the server has some). Stored prices stay as the merchant set them.
    const body = getAuth(res).isAdmin ? storeInventoryData : forMerchant(withoutAdminSettings(storeInventoryData));
    res.send({ ...body, fx: currentFxRates() });
  } catch (e) {
    log.error({ err: e }, "In store/inventory/get-data");
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}

/* An item's review status without the check's reasons or fingerprint (L.2). */
export function forMerchant(data: StoreInventoryData): StoreInventoryData {
  return {
    ...data,
    items: data.items.map(({ storeItemCheckedHash: _h, storeItemReview, ...item }) =>
      storeItemReview ? { ...item, storeItemReview: { ...storeItemReview, reasons: [] } } : item
    ),
  };
}
