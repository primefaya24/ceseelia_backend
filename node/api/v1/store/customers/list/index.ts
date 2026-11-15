import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../../layers/core/http/cache";
import { listStoreCustomers } from "../../../../../layers/aws/dynamodb/dynamo-entities/customer";
import { log } from "../../../../../layers/core/logger";

/*
 * GET /store/customers/list/:storeId (store members, progress.md L.7 / 7.1, WA 7.1)
 *   → 200 { customers: StoreCustomer[], partial }
 *
 * Everyone who has paid for an order at the store: contact details from their newest order,
 * paid orders, total spent per currency net of refunds, first and last order. Most recent first,
 * all of them (≤ 5,000; the webapp searches and sorts in the page). The same people and details
 * members already see order by order on the Orders page.
 */
export default function registerRoute(router: Router): void {
  router.get("/list/:storeId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, () => true, () => true, executeRouteCore, true, storeMember((req) => req.params.storeId));
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    res.send(await listStoreCustomers(String(req.params.storeId)));
  } catch (e) {
    log.error({ err: e }, "In store/customers/list");
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
