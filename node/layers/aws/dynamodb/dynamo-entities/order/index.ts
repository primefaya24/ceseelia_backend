// Store orders (progress.md 5.3).
//
//   STORE#<storeId> / ORDER#<createdAt>#<orderId>   the order (StoreOrder), newest last
//   ORDER#<orderId> / ORDER                         pointer { storeId, sk } to find it by id
// Both are written in one transaction when checkout creates the order (5.4); the pointer never
// changes. The ORDER#<createdAt> sort key lets the merchant's list (6.1) page by date.
import { createHash, randomBytes, randomInt } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../../constants";
import { DB_TABLE_NAME } from "../../../../../config";
import { StoreOrder } from "../../../../core/interfaces/store";

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
