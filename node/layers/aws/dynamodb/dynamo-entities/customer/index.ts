import { createHash } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../../constants";
import { DB_TABLE_NAME } from "../../../../../config";
import { StoreOrder } from "../../../../core/interfaces/store";

/*
 * A store's customers (progress.md L.7 / 7.1), built from its paid orders:
 *   `STORE#<storeId> / CUSTOMER#<id>`        { email, name, phone, orders, spent_<CUR> (minor,
 *       net of refunds), firstOrderAt, lastOrderAt, lastOrderId, lastOrderCode }
 *   `STORE#<storeId> / CUSTOMER_ORDER#<orderId>`  { customerId, currency, refundedMinor }
 * `id` = sha256 of the trimmed, lower-cased email (32 hex), so emails stay out of keys.
 *
 * `recordCustomerOrder(order)` is the only writer and is idempotent: the order's marker row and
 * the customer's counters change in one transaction, conditional on the marker (absent → the
 * order is added; present → only the change in its refunds is applied). Webhook retries, the
 * sweeper and a backfill can all call it any number of times. The newest order's name and phone
 * win (a separate update, conditional on being newer). Amounts are per currency: never added.
 */
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: appConstants.DEFAULT_REGION }));
const TABLE = DB_TABLE_NAME;

export const CUSTOMER = "CUSTOMER";
export const CUSTOMER_ORDER = "CUSTOMER_ORDER";
/** The most customers a list reads; beyond it the list says `partial`. */
export const CUSTOMER_LIST_CAP = 5000;

const storePk = (storeId: string) => `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}`;
const CURRENCY = /^[A-Z]{3}$/;

export const customerIdFor = (email: string): string =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);

export interface StoreCustomer {
  customerId: string;
  email: string;
  name: string;
  phone: string;
  orders: number;
  /** Net of refunds, per currency, largest first. */
  spent: { currency: string; minor: number }[];
  firstOrderAt: number;
  lastOrderAt: number;
  lastOrderId: string;
  lastOrderCode: string;
}

/** An order counts once paid; one never paid (or cancelled unpaid) doesn't. */
const counts = (o: StoreOrder) =>
  typeof o.storeOrderPaidAt === "number" && o.storeOrderStatus !== "PENDING_PAYMENT" && o.storeOrderStatus !== "CANCELLED";

export type RecordResult = "ADDED" | "UPDATED" | "UNCHANGED" | "SKIPPED";

export async function recordCustomerOrder(order: StoreOrder): Promise<RecordResult> {
  // A transaction that lost a race (another call recorded the same order first) re-reads.
  for (let i = 0; ; i++) {
    try {
      return await recordOnce(order);
    } catch (e) {
      if ((e as { name?: string }).name !== "TransactionCanceledException" || i >= 2) throw e;
    }
  }
}

async function recordOnce(order: StoreOrder): Promise<RecordResult> {
  const email = order.storeOrderCustomer?.email?.trim().toLowerCase();
  const cur = order.storeOrderCurrency;
  if (!email || !CURRENCY.test(cur) || !counts(order)) return "SKIPPED";
  const pk = storePk(order.storeId);
  const customerId = customerIdFor(email);
  const markerKey = { pk, sk: `${CUSTOMER_ORDER}#${order.storeOrderId}` };
  const customerKey = { pk, sk: `${CUSTOMER}#${customerId}` };
  const refunded = Math.min(order.storeOrderTotalMinor, Math.max(0, order.storeOrderRefundedMinor ?? 0));
  const spentName = `spent_${cur}`;

  const marker = (await ddb.send(new GetCommand({ TableName: TABLE, Key: markerKey, ConsistentRead: true }))).Item;
  let result: RecordResult;
  if (!marker) {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: { ...markerKey, customerId, currency: cur, refundedMinor: refunded },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: customerKey,
              UpdateExpression:
                "ADD #orders :one, #spent :net SET #email = :email, #first = if_not_exists(#first, :paid), #cid = :cid",
              ExpressionAttributeNames: { "#orders": "orders", "#spent": spentName, "#email": "email", "#first": "firstOrderAt", "#cid": "customerId" },
              ExpressionAttributeValues: { ":one": 1, ":net": order.storeOrderTotalMinor - refunded, ":email": email, ":paid": order.storeOrderPaidAt, ":cid": customerId },
            },
          },
        ],
      })
    );
    result = "ADDED";
  } else {
    const before = Number(marker.refundedMinor ?? 0);
    if (before === refunded) return "UNCHANGED";
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: markerKey,
              UpdateExpression: "SET refundedMinor = :now",
              ConditionExpression: "refundedMinor = :before",
              ExpressionAttributeValues: { ":now": refunded, ":before": before },
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: { pk, sk: `${CUSTOMER}#${marker.customerId}` },
              UpdateExpression: "ADD #spent :delta",
              ExpressionAttributeNames: { "#spent": `spent_${marker.currency}` },
              ExpressionAttributeValues: { ":delta": before - refunded },
            },
          },
        ],
      })
    );
    return "UPDATED";
  }

  // The newest order's contact details and link (older orders recorded later don't overwrite).
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: customerKey,
        UpdateExpression: "SET #name = :name, #phone = :phone, #last = :paid, #lid = :lid, #lcode = :lcode",
        ConditionExpression: "attribute_not_exists(#last) OR #last <= :paid",
        ExpressionAttributeNames: { "#name": "name", "#phone": "phone", "#last": "lastOrderAt", "#lid": "lastOrderId", "#lcode": "lastOrderCode" },
        ExpressionAttributeValues: {
          ":name": order.storeOrderCustomer.name ?? "",
          ":phone": order.storeOrderCustomer.phone ?? "",
          ":paid": order.storeOrderPaidAt,
          ":lid": order.storeOrderId,
          ":lcode": order.storeOrderCode,
        },
      })
    );
  } catch (e) {
    if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
  }
  return result;
}

export function customerFromRow(row: Record<string, unknown>): StoreCustomer {
  const spent = Object.entries(row)
    .filter(([k, v]) => k.startsWith("spent_") && typeof v === "number")
    .map(([k, v]) => ({ currency: k.slice(6), minor: Math.max(0, v as number) }))
    .sort((a, b) => b.minor - a.minor || a.currency.localeCompare(b.currency));
  return {
    customerId: String(row.customerId ?? String(row.sk ?? "").slice(CUSTOMER.length + 1)),
    email: String(row.email ?? ""),
    name: String(row.name ?? ""),
    phone: String(row.phone ?? ""),
    orders: Number(row.orders ?? 0),
    spent,
    firstOrderAt: Number(row.firstOrderAt ?? 0),
    lastOrderAt: Number(row.lastOrderAt ?? row.firstOrderAt ?? 0),
    lastOrderId: String(row.lastOrderId ?? ""),
    lastOrderCode: String(row.lastOrderCode ?? ""),
  };
}

/** Every customer of the store (≤ cap), the most recent order first. */
export async function listStoreCustomers(
  storeId: string,
  cap = CUSTOMER_LIST_CAP
): Promise<{ customers: StoreCustomer[]; partial: boolean }> {
  const out: StoreCustomer[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)",
        ExpressionAttributeValues: { ":pk": storePk(storeId), ":p": `${CUSTOMER}#` },
        ...(start ? { ExclusiveStartKey: start } : {}),
      })
    );
    for (const row of res.Items ?? []) out.push(customerFromRow(row));
    start = res.LastEvaluatedKey;
  } while (start && out.length < cap);
  out.sort((a, b) => b.lastOrderAt - a.lastOrderAt || a.email.localeCompare(b.email));
  return { customers: out.slice(0, cap), partial: !!start || out.length > cap };
}
