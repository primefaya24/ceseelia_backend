import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../../constants";
import { DB_TABLE_NAME } from "../../../../../config";
import { StoreOrder } from "../../../../core/interfaces/store";

/*
 * New-order alerts for the dashboard (progress.md L.5 / WA 6.4):
 *   `STORE#<storeId> / ORDER_ALERT#<at>#<orderId>`  { orderId, orderCode, totalMinor, currency,
 *       orderType, paidAt, at, ttl }
 * One row when an order is first paid (`alertNewOrder`, after the payment is recorded; best
 * effort like the emails). `at` is when the row was written, zero-padded so the sort key orders
 * by time; the dashboard polls for rows after the last `now` it was given (minus an overlap, and
 * it skips ids it has seen). DynamoDB's TTL (`ttl`, seconds) removes rows after a week; the store
 * delete removes them with the rest of the partition. No shopper details: ids, code and total.
 */
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: appConstants.DEFAULT_REGION }));
const TABLE = DB_TABLE_NAME;

export const ORDER_ALERT = "ORDER_ALERT";
export const ORDER_ALERT_TTL_S = 7 * 24 * 3600;
/** The most a poll returns; a store with more new orders than this between polls sees the newest. */
export const ORDER_ALERT_PAGE = 20;

const storePk = (storeId: string) => `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}`;
const pad = (ms: number) => String(Math.max(0, Math.floor(ms))).padStart(13, "0");

export interface OrderAlert {
  orderId: string;
  orderCode: string;
  totalMinor: number;
  currency: string;
  orderType: string;
  paidAt: number;
  /** When the alert was written (ms). */
  at: number;
}

export function orderAlertFor(order: StoreOrder, now: number): OrderAlert {
  return {
    orderId: order.storeOrderId,
    orderCode: order.storeOrderCode,
    totalMinor: order.storeOrderTotalMinor,
    currency: order.storeOrderCurrency,
    orderType: order.storeOrderType,
    paidAt: order.storeOrderPaidAt ?? now,
    at: now,
  };
}

export async function putOrderAlert(order: StoreOrder, now = Date.now()): Promise<OrderAlert> {
  const alert = orderAlertFor(order, now);
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: storePk(order.storeId),
        sk: `${ORDER_ALERT}#${pad(now)}#${order.storeOrderId}`,
        ...alert,
        ttl: Math.floor(now / 1000) + ORDER_ALERT_TTL_S,
      },
    })
  );
  return alert;
}

/** Alerts written after `since` (ms), newest first, at most ORDER_ALERT_PAGE. */
export async function listOrderAlertsSince(storeId: string, since: number): Promise<OrderAlert[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": storePk(storeId),
        ":from": `${ORDER_ALERT}#${pad(since + 1)}`,
        ":to": `${ORDER_ALERT}#~`,
      },
      ScanIndexForward: false,
      Limit: ORDER_ALERT_PAGE,
    })
  );
  return (res.Items ?? []).map((r) => ({
    orderId: String(r.orderId),
    orderCode: String(r.orderCode ?? ""),
    totalMinor: Number(r.totalMinor ?? 0),
    currency: String(r.currency ?? ""),
    orderType: String(r.orderType ?? ""),
    paidAt: Number(r.paidAt ?? r.at),
    at: Number(r.at),
  }));
}
