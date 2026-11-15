import { StoreOrder } from "../core/interfaces/store";
import { rewardsProgram } from "../core/rewards";
import { getStoreRewardsSettings } from "../aws/dynamodb/dynamo-entities/store";
import { recordRewardsForOrder } from "../aws/dynamodb/dynamo-entities/rewards";
import { returnRewardsSpend } from "../aws/dynamodb/dynamo-entities/order";
import { log } from "../core/logger";

/*
 * Rewards after payment events (L.7 / 7.4). Best effort and idempotent (safe on webhook retries
 * and the sweeper): a failure is logged with ids only, never stops the payment flow.
 */

/** First paid: the order's points, at the store's rate now (no program now = no points). */
export async function rewardsAfterPaid(order: StoreOrder): Promise<void> {
  try {
    const program = rewardsProgram((await getStoreRewardsSettings(order.storeId)) ?? undefined);
    await recordRewardsForOrder(order, program?.pointsPerUnit ?? null, Date.now());
  } catch (e) {
    log.error({ err: e, orderId: order.storeOrderId }, "In rewards after paid");
  }
}

/** Refunds changed: the order's points follow; a full refund also gives spent points back. */
export async function rewardsAfterRefund(order: StoreOrder): Promise<void> {
  try {
    await recordRewardsForOrder(order, null, Date.now());
    if (order.storeOrderStatus === "REFUNDED") await returnRewardsSpend(order);
  } catch (e) {
    log.error({ err: e, orderId: order.storeOrderId }, "In rewards after refund");
  }
}
