import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../../layers/core/http/cache";
import { isUlid } from "../../../../../layers/core/utils";
import { merchantOrderView } from "../../../../../layers/core/interfaces/store";
import { getOrderById } from "../../../../../layers/aws/dynamodb/dynamo-entities/order";
import { log } from "../../../../../layers/core/logger";

/*
 * GET /store/orders/get/:storeId/:orderId (store members, progress.md 6.2) → 200 MerchantOrderView
 * (the whole order but the shopper's token hash). Another store's order is 404 ORDER_NOT_FOUND,
 * like a missing one.
 */
export default function registerRoute(router: Router): void {
  router.get("/get/:storeId/:orderId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      () => true,
      (req) => isUlid(req.params.orderId),
      executeRouteCore,
      true,
      storeMember((req) => req.params.storeId)
    );
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    const order = await getOrderById(String(req.params.orderId));
    if (!order || order.storeId !== req.params.storeId) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "ORDER_NOT_FOUND", message: "Order not found" });
      return;
    }
    res.send(merchantOrderView(order));
  } catch (e) {
    log.error({ err: e }, "In store/orders/get");
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
