// Store orders (progress.md 5.3).
//
//   STORE#<storeId> / ORDER#<createdAt>#<orderId>   the order (StoreOrder), newest last
//   ORDER#<orderId> / ORDER                         pointer { storeId, sk } to find it by id
// Both are written in one transaction when checkout creates the order (5.4); the pointer never
// changes. The ORDER#<createdAt> sort key lets the merchant's list (6.1) page by date.
import { createHash, randomBytes, randomInt } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  TransactWriteCommandInput,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../../constants";
import { STOCK_UNLIMITED } from "../../../../../constants/input-limits";
import { DB_TABLE_NAME } from "../../../../../config";
import { StoreItem, StoreOrder, StoreOrderCancelReason, StoreOrderLine } from "../../../../core/interfaces/store";
import { findVariant, hasVariants } from "../../../../core/variants";
import { dynamGetManyItems } from "../../dynamo-batch-ops";

const dynamoDbDocumentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: appConstants.DEFAULT_REGION })
);
const TABLE = DB_TABLE_NAME;
const ORDER = appConstants.DYNAMO_ENTITY_ORDER;

export const orderKey = (storeId: string, createdAt: number, orderId: string) => ({
  pk: `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}`,
  sk: `${ORDER}#${createdAt}#${orderId}`,
});
export const orderPointerKey = (orderId: string) => ({ pk: `${ORDER}#${orderId}`, sk: ORDER });

/* Crockford base32 without look-alikes: what a shopper reads out to the merchant. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newOrderCode(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/* The shopper's status token (returned once) and the hash the order keeps. */
export function newStatusToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: hashStatusToken(token) };
}
export const hashStatusToken = (token: string) => createHash("sha256").update(token).digest("hex");

/* Write a new order and its pointer together. Throws if either already exists. */
export async function createOrderRecords(order: StoreOrder): Promise<void> {
  const key = orderKey(order.storeId, order.storeOrderCreatedAt, order.storeOrderId);
  await dynamoDbDocumentClient.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: { ...key, ...order }, ConditionExpression: "attribute_not_exists(pk)" } },
        {
          Put: {
            TableName: TABLE,
            Item: { ...orderPointerKey(order.storeOrderId), storeId: order.storeId, orderSk: key.sk },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    })
  );
}

/* An order by its id (via the pointer), or null. */
export async function getOrderById(orderId: string): Promise<StoreOrder | null> {
  const pointer = await dynamoDbDocumentClient.send(
    new GetCommand({ TableName: TABLE, Key: orderPointerKey(orderId), ConsistentRead: true })
  );
  const storeId = pointer.Item?.storeId;
  const sk = pointer.Item?.orderSk;
  if (typeof storeId !== "string" || typeof sk !== "string") return null;
  const res = await dynamoDbDocumentClient.send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}`, sk },
      ConsistentRead: true,
    })
  );
  if (!res.Item) return null;
  const { pk: _pk, sk: _sk, ...order } = res.Item;
  return order as StoreOrder;
}

const storePk = (storeId: string) => `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}`;
const keyOf = (o: StoreOrder) => orderKey(o.storeId, o.storeOrderCreatedAt, o.storeOrderId);
const overviewKey = (storeId: string) => ({
  pk: appConstants.DYNAMO_ENTITY_APP_STORE,
  sk: `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}#${appConstants.DYNAMO_ENTITY_OVERVIEW}`,
});
/* APP / ORDER#<paidAt>#STORE#<storeId>#<orderId>: the admin's sales activity (5.6d, 8.1). */
export const appOrderKey = (paidAt: number, storeId: string, orderId: string) => ({
  pk: appConstants.DYNAMO_ENTITY_APP,
  sk: `${ORDER}#${paidAt}#${appConstants.DYNAMO_ENTITY_STORE}#${storeId}#${orderId}`,
});

type TxItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

/* Which transaction item failed its condition, or -1. */
function failedIndex(e: unknown): number {
  const err = e as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  if (err?.name !== "TransactionCanceledException") return -1;
  return (err.CancellationReasons ?? []).findIndex((r) => r?.Code === "ConditionalCheckFailed");
}

/*
 * The stock updates a paid order makes (5.6b): one Update per item (a transaction can't touch an
 * item twice), lowering tracked stock only: the item's count, or for an item with variants (2.7)
 * each picked row's `storeVariantStock` (conditioned on that row still being the same options)
 * and the item's total. Unlimited stock (-1) is left alone. `missing`: a line whose item or
 * row is gone, which can't be decremented.
 */
export function stockUpdates(storeId: string, lines: StoreOrderLine[], items: StoreItem[]): { updates: TxItem[]; missing: boolean } {
  const byId = new Map(items.map((i) => [i.storeItemId, i]));
  const lineGroups = new Map<string, StoreOrderLine[]>();
  for (const l of lines) lineGroups.set(l.itemId, [...(lineGroups.get(l.itemId) ?? []), l]);
  const updates: TxItem[] = [];
  let missing = false;
  for (const [itemId, group] of lineGroups) {
    const item = byId.get(itemId);
    if (!item) {
      missing = true;
      continue;
    }
    const sets: string[] = [];
    const conds: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    let trackedQty = 0;
    if (hasVariants(item)) {
      const rows = new Map<number, number>();
      for (const l of group) {
        const picks = Object.fromEntries(l.params.map((p) => [p.label, p.values[0] ?? ""]));
        const row = findVariant(item, picks);
        const idx = row ? (item.storeItemVariants ?? []).indexOf(row) : -1;
        if (idx < 0) {
          missing = true;
          continue;
        }
        if (row!.storeVariantStock === STOCK_UNLIMITED) continue;
        rows.set(idx, (rows.get(idx) ?? 0) + l.quantity);
      }
      names["#v"] = "storeItemVariants";
      names["#vs"] = "storeVariantStock";
      names["#vo"] = "storeVariantOptions";
      for (const [idx, qty] of rows) {
        sets.push(`#v[${idx}].#vs = #v[${idx}].#vs - :q${idx}`);
        conds.push(`#v[${idx}].#vs >= :q${idx}`, `#v[${idx}].#vo = :o${idx}`);
        values[`:q${idx}`] = qty;
        values[`:o${idx}`] = item.storeItemVariants![idx].storeVariantOptions;
        trackedQty += qty;
      }
    } else if (item.storeItemStock !== STOCK_UNLIMITED) {
      trackedQty = group.reduce((n, l) => n + l.quantity, 0);
    }
    if (trackedQty > 0 && item.storeItemStock !== STOCK_UNLIMITED) {
      names["#s"] = "storeItemStock";
      sets.push("#s = #s - :q");
      conds.push("#s >= :q");
      values[":q"] = trackedQty;
    }
    if (sets.length === 0) continue;
    updates.push({
      Update: {
        TableName: TABLE,
        Key: { pk: storePk(storeId), sk: `${appConstants.DYNAMO_ENTITY_ITEM}#${itemId}` },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: conds.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    });
  }
  return { updates, missing };
}

export type MarkPaidResult = "PAID" | "PAID_SHORT" | "ALREADY";

/*
 * Paid (5.6): PENDING_PAYMENT → PAID with the PaymentIntent, in one transaction with the stock
 * decrements, the store's order count and the admin's sales record. Conditional on the order
 * still being PENDING_PAYMENT, so a repeated event changes nothing ("ALREADY"). If stock ran out
 * meanwhile (or an item is gone), the order is still PAID (the shopper has paid) but flagged
 * `storeOrderStockShortfall` with no stock change ("PAID_SHORT").
 */
export async function markOrderPaid(order: StoreOrder, paymentIntentId: string, now = Date.now()): Promise<MarkPaidResult> {
  const itemIds = [...new Set(order.storeOrderLines.map((l) => l.itemId))];
  const rows = await dynamGetManyItems(
    TABLE,
    itemIds.map((id) => ({ pk: storePk(order.storeId), sk: `${appConstants.DYNAMO_ENTITY_ITEM}#${id}` }))
  );
  const { updates, missing } = stockUpdates(order.storeId, order.storeOrderLines, rows as unknown as StoreItem[]);

  const paid = (shortfall: boolean): TxItem => ({
    Update: {
      TableName: TABLE,
      Key: keyOf(order),
      UpdateExpression: `SET #st = :paid, #stripe.#pi = :pi, #paidAt = :now, #upd = :now${shortfall ? ", #short = :true" : ""}`,
      ConditionExpression: "#st = :pending",
      ExpressionAttributeNames: {
        "#st": "storeOrderStatus",
        "#stripe": "storeOrderStripe",
        "#pi": "paymentIntentId",
        "#paidAt": "storeOrderPaidAt",
        "#upd": "storeOrderUpdatedAt",
        ...(shortfall ? { "#short": "storeOrderStockShortfall" } : {}),
      },
      ExpressionAttributeValues: {
        ":paid": "PAID",
        ":pending": "PENDING_PAYMENT",
        ":pi": paymentIntentId,
        ":now": now,
        ...(shortfall ? { ":true": true } : {}),
      },
    },
  });
  const counters: TxItem[] = [
    {
      Update: {
        TableName: TABLE,
        Key: overviewKey(order.storeId),
        UpdateExpression: "ADD #count :one",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#count": "storeOrderCount" },
        ExpressionAttributeValues: { ":one": 1 },
      },
    },
    {
      Put: {
        TableName: TABLE,
        Item: {
          ...appOrderKey(now, order.storeId, order.storeOrderId),
          storeId: order.storeId,
          orderId: order.storeOrderId,
          currency: order.storeOrderCurrency,
          totalMinor: order.storeOrderTotalMinor,
          platformFeeMinor: order.storeOrderPlatformFeeMinor,
          paidAt: now,
        },
      },
    },
  ];

  const attempt = async (items: TxItem[]) =>
    dynamoDbDocumentClient.send(new TransactWriteCommand({ TransactItems: items }));
  const [count, sale] = counters;
  // Each try: what to write, and whether the order ends up flagged short.
  const tries: Array<[TxItem[], boolean]> = [
    [[paid(missing), ...updates, count, sale], missing],
  ];
  try {
    await attempt(tries[0][0]);
    return missing ? "PAID_SHORT" : "PAID";
  } catch (e) {
    const at = failedIndex(e);
    if (at === 0) return "ALREADY";
    if (at < 0) throw e;
    if (at <= updates.length) {
      // Stock ran out after the shopper paid: paid, flagged, no stock change.
      tries.push([[paid(true), count, sale], true], [[paid(true)], true]);
    } else {
      // The store's overview row is gone (store deleted): keep everything else.
      tries.push([[paid(missing), ...updates, sale], missing], [[paid(true)], true]);
    }
  }
  for (const [items, short] of tries.slice(1)) {
    try {
      await attempt(items);
      return short ? "PAID_SHORT" : "PAID";
    } catch (e) {
      const at = failedIndex(e);
      if (at === 0) return "ALREADY";
      if (at < 0) throw e;
    }
  }
  throw new Error(`Order ${order.storeOrderId}: couldn't record the payment`);
}

/* PENDING_PAYMENT → CANCELLED (5.5c: the session expired or the payment failed). False if it wasn't pending. */
export async function cancelPendingOrder(order: StoreOrder, reason: StoreOrderCancelReason, now = Date.now()): Promise<boolean> {
  try {
    await dynamoDbDocumentClient.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: keyOf(order),
        UpdateExpression: "SET #st = :cancelled, #why = :why, #upd = :now",
        ConditionExpression: "#st = :pending",
        ExpressionAttributeNames: { "#st": "storeOrderStatus", "#why": "storeOrderCancelReason", "#upd": "storeOrderUpdatedAt" },
        ExpressionAttributeValues: { ":cancelled": "CANCELLED", ":pending": "PENDING_PAYMENT", ":why": reason, ":now": now },
      })
    );
    return true;
  } catch (e) {
    if ((e as { name?: string })?.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/*
 * A refund made in the merchant's Stripe dashboard (or by us, 6.2), 5.5d: the amount refunded so
 * far; a full refund makes a paid order REFUNDED. Never touches an order that wasn't paid.
 */
export async function recordOrderRefund(order: StoreOrder, refundedMinor: number, full: boolean, now = Date.now()): Promise<void> {
  const paidStatuses = ["PAID", "PREPARING", "READY", "SHIPPED", "COMPLETED", "REFUNDED"];
  try {
    await dynamoDbDocumentClient.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: keyOf(order),
        UpdateExpression: `SET #ref = :ref, #upd = :now${full ? ", #st = :refunded" : ""}`,
        ConditionExpression: `#st IN (${paidStatuses.map((_, i) => `:s${i}`).join(", ")})`,
        ExpressionAttributeNames: { "#ref": "storeOrderRefundedMinor", "#upd": "storeOrderUpdatedAt", "#st": "storeOrderStatus" },
        ExpressionAttributeValues: {
          ":ref": refundedMinor,
          ":now": now,
          ...(full ? { ":refunded": "REFUNDED" } : {}),
          ...Object.fromEntries(paidStatuses.map((s, i) => [`:s${i}`, s])),
        },
      })
    );
  } catch (e) {
    if ((e as { name?: string })?.name !== "ConditionalCheckFailedException") throw e;
  }
}

/* The latest dispute on an order's payment (5.5d). */
export async function recordOrderDispute(order: StoreOrder, status: string, amountMinor: number, now = Date.now()): Promise<void> {
  await dynamoDbDocumentClient.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: keyOf(order),
      UpdateExpression: "SET #d = :d, #upd = :now",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#d": "storeOrderDispute", "#upd": "storeOrderUpdatedAt" },
      ExpressionAttributeValues: { ":d": { status, amountMinor, updatedAt: now }, ":now": now },
    })
  );
}

/*
 * Processed Connect events (5.5b): STRIPE_EVENT#<id> / EVENT, with `expiresAt` (seconds, for a
 * TTL on the table if one is set up). Handlers are idempotent anyway; this skips repeats early.
 */
const eventKey = (id: string) => ({ pk: `STRIPE_EVENT#${id}`, sk: "EVENT" });
export async function wasEventProcessed(id: string): Promise<boolean> {
  const res = await dynamoDbDocumentClient.send(new GetCommand({ TableName: TABLE, Key: eventKey(id) }));
  return !!res.Item;
}
export async function markEventProcessed(id: string, type: string, now = Date.now()): Promise<void> {
  await dynamoDbDocumentClient.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...eventKey(id), type, processedAt: now, expiresAt: Math.floor(now / 1000) + 30 * 24 * 3600 },
    })
  );
}
