import { StoreOrder } from "../core/interfaces/store";
import { putOrderAlert } from "../aws/dynamodb/dynamo-entities/order-alert";
import { listStoreMembers } from "../aws/dynamodb/dynamo-entities/membership";
import { money } from "./order-email-templates";
import { pushToUser } from "./web-push";
import { log } from "../core/logger";

/*
 * A new paid order, for the merchant's dashboard (progress.md L.5): the alert row the dashboard
 * polls (toast, sound, the bell's badge) and a web push to every member's browsers that turned it
 * on. Called once per order, when it's first paid (`notifyOrderPaid`). Best effort: never throws.
 */
export function newOrderPush(order: StoreOrder, storeName: string) {
  const how = order.storeOrderType === "DELIVERY" ? "Delivery" : "Pickup";
  return {
    title: storeName ? `New order · ${storeName}` : "New order",
    body: `#${order.storeOrderCode} · ${money(order.storeOrderTotalMinor, order.storeOrderCurrency)} · ${how}`,
    url: `/store/orders/${order.storeId}?order=${order.storeOrderId}`,
    tag: `order-${order.storeOrderId}`,
  };
}

/** `memberIds`: the store's members if the caller has them (else they're read here). */
export async function alertNewOrder(order: StoreOrder, storeName: string, memberIds?: string[], now = Date.now()): Promise<void> {
  const row = putOrderAlert(order, now).catch((e) =>
    log.error({ err: e, orderId: order.storeOrderId }, "[order alerts] alert row not written")
  );
  const push = (async () => {
    const ids = memberIds ?? (await listStoreMembers(order.storeId)).map((m) => m.userId);
    const payload = newOrderPush(order, storeName);
    await Promise.all(ids.map((id) => pushToUser(id, payload)));
  })().catch((e) => log.error({ err: e, orderId: order.storeOrderId }, "[order alerts] push failed"));
  await Promise.all([row, push]);
}
