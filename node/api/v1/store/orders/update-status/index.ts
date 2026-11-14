import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { getAuth, storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { isUlid } from "../../../../../layers/core/utils";
import {
  merchantOrderView,
  nextOrderStatuses,
  STORE_ORDER_STATUSES,
  StoreOrderStatus,
} from "../../../../../layers/core/interfaces/store";
import { getOrderById, updateOrderStatus } from "../../../../../layers/aws/dynamodb/dynamo-entities/order";

/*
 * PUT /store/orders/update-status (store members, progress.md 6.3)
 * Body { storeId, orderId, status, fromStatus } → 200 MerchantOrderView (updated)
 *
 * Forward only (`nextOrderStatuses`): Paid → Preparing → Ready → Shipped (deliveries) →
 * Completed, steps may be skipped. `fromStatus` is the status the merchant was looking at; the
 * change only happens from it.
 *   - 409 INVALID_TRANSITION { order }: not a step forward from where the order is (unpaid,
 *     cancelled, refunded, or going back). Cancelling a paid order is a refund (6.4).
 *   - 409 STATUS_CHANGED { order }: someone moved it on meanwhile; the current order comes back.
 *   - 404 ORDER_NOT_FOUND (also another store's order).
 */
export default function registerRoute(router: Router): void {
  router.put("/update-status", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      pureRequestParams,
      validRequestParams,
      executeRouteCore,
      true,
      storeMember((req) => req.body.storeId)
    );
  });
}

const isStatus = (v: unknown): v is StoreOrderStatus => (STORE_ORDER_STATUSES as readonly unknown[]).includes(v);

function pureRequestParams(req: Request): boolean {
  const b = req.body;
  return typeof b?.storeId === "string" && typeof b.orderId === "string" && typeof b.status === "string" && typeof b.fromStatus === "string";
}

function validRequestParams(req: Request): boolean {
  const b = req.body;
  return isUlid(b.storeId) && isUlid(b.orderId) && isStatus(b.status) && isStatus(b.fromStatus);
}

const notFound = (res: Response) =>
  res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "ORDER_NOT_FOUND", message: "Order not found" });

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  const { storeId, orderId } = req.body as { storeId: string; orderId: string };
  const to = req.body.status as StoreOrderStatus;
  const from = req.body.fromStatus as StoreOrderStatus;
  try {
    const order = await getOrderById(orderId);
    if (!order || order.storeId !== storeId) {
      notFound(res);
      return;
    }
    if (order.storeOrderStatus !== from) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({
        code: "STATUS_CHANGED",
        message: "This order was updated meanwhile.",
        order: merchantOrderView(order),
      });
      return;
    }
    if (!nextOrderStatuses(from, order.storeOrderType).includes(to)) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({
        code: "INVALID_TRANSITION",
        message: "This order can't be moved to that status.",
        order: merchantOrderView(order),
      });
      return;
    }
    const auth = getAuth(res);
    const by = auth.isAdmin ? "ADMIN" : (auth.userId ?? auth.cognitoId);
    const now = Date.now();
    if (!(await updateOrderStatus(order, from, to, by, now))) {
      const current = await getOrderById(orderId);
      if (!current) {
        notFound(res);
        return;
      }
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({
        code: "STATUS_CHANGED",
        message: "This order was updated meanwhile.",
        order: merchantOrderView(current),
      });
      return;
    }
    res.send(
      merchantOrderView({
        ...order,
        storeOrderStatus: to,
        storeOrderUpdatedAt: now,
        storeOrderStatusHistory: [...(order.storeOrderStatusHistory ?? []), { status: to, at: now, by }],
      })
    );
  } catch (e) {
    console.error("In store/orders/update-status", e);
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
