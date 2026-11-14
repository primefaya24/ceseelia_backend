import { timingSafeEqual } from "crypto";
import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { createRateLimiter } from "../../../../layers/core/http/rate-limit";
import { getClientIp, isUlid } from "../../../../layers/core/utils";
import { StoreOrder } from "../../../../layers/core/interfaces/store";
import { getOrderById, hashStatusToken } from "../../../../layers/aws/dynamodb/dynamo-entities/order";
import { getStoreOverviewRow } from "../../../../layers/aws/dynamodb/dynamo-entities/membership";

/*
 * GET /customer/order-status/:orderId (public; progress.md 6.4, used by WA 5.2's return page)
 * Header `X-Order-Token: <statusToken>` (from create-order; a header so it stays out of URLs and
 * logs). → 200 the shopper's view of the order. A wrong token and an unknown order are the same
 * 404 ORDER_NOT_FOUND, so order ids can't be probed. 60 per IP per minute (the return page polls
 * until the webhook marks the order paid) → 429.
 */
export const orderStatusLimit = createRateLimiter({ windowMs: 60_000, max: 60 });

export default function registerRoute(router: Router): void {
  router.get("/order-status/:orderId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore, false);
  });
}

function pureRequestParams(req: Request): boolean {
  return typeof req.params.orderId === "string" && typeof req.header("x-order-token") === "string";
}

function validRequestParams(req: Request): boolean {
  const token = req.header("x-order-token") ?? "";
  return isUlid(req.params.orderId) && token.length > 0 && token.length <= 64;
}

const sameHash = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/* What the shopper may see: no Stripe ids, fee, commission or token hash. */
export function shopperOrderView(o: StoreOrder, store: { storeName: string; storeSlug: string }) {
  return {
    orderId: o.storeOrderId,
    orderCode: o.storeOrderCode,
    storeId: o.storeId,
    storeName: store.storeName,
    storeSlug: store.storeSlug,
    status: o.storeOrderStatus,
    cancelReason: o.storeOrderCancelReason ?? null,
    type: o.storeOrderType,
    currency: o.storeOrderCurrency,
    customer: o.storeOrderCustomer,
    address: o.storeOrderAddress,
    note: o.storeOrderNote,
    lines: o.storeOrderLines,
    subtotalMinor: o.storeOrderSubtotalMinor,
    discountMinor: o.storeOrderDiscountMinor,
    deliveryMinor: o.storeOrderDeliveryMinor,
    taxMinor: o.storeOrderTaxMinor,
    taxLines: o.storeOrderTaxLines,
    pricesIncludeTax: o.storeOrderPricesIncludeTax,
    totalMinor: o.storeOrderTotalMinor,
    refundedMinor: o.storeOrderRefundedMinor ?? 0,
    createdAt: o.storeOrderCreatedAt,
    paidAt: o.storeOrderPaidAt ?? null,
  };
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const limited = orderStatusLimit.take(`ip:${getClientIp(req) ?? "unknown"}`);
  if (!limited.ok) {
    res.set("Retry-After", String(limited.retryAfterSeconds));
    res.status(429).send({ code: "RATE_LIMITED", message: "Too many requests. Please try again shortly." });
    return;
  }
  try {
    const order = await getOrderById(String(req.params.orderId));
    if (!order || !sameHash(order.storeOrderStatusTokenHash ?? "", hashStatusToken(req.header("x-order-token")!))) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "ORDER_NOT_FOUND", message: "Order not found" });
      return;
    }
    const overview = await getStoreOverviewRow(order.storeId);
    res.send(
      shopperOrderView(order, {
        storeName: String(overview?.storeName ?? ""),
        storeSlug: String(overview?.storeSlug ?? ""),
      })
    );
  } catch (e) {
    console.error("In customer/order-status", e);
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
