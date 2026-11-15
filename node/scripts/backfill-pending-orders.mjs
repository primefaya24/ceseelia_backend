// One-off (5.7, 2026-11-14): lists every PENDING_PAYMENT order saved before create-order wrote
// the sweeper's row (APP_PENDING_ORDER / ORDER#<createdAt>#<orderId>), so the lost-order
// sweeper can settle it. Only pending orders are listed; paid or cancelled ones need nothing.
// Safe to run again: an existing row is left alone.
//
//   node scripts/backfill-pending-orders.mjs          # dry run against ceseelia_dev
//   node scripts/backfill-pending-orders.mjs --write  # apply
//   DB_TABLE_NAME=ceseelia_prod node scripts/backfill-pending-orders.mjs --write
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.DB_TABLE_NAME || "ceseelia_dev";
const WRITE = process.argv.includes("--write");
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

async function queryAll(input) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({ TableName: TABLE, ...input, ExclusiveStartKey }));
    out.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

const stores = await queryAll({
  KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
  ExpressionAttributeValues: { ":pk": "APP_STORE", ":sk": "STORE#" },
  ProjectionExpression: "storeId, storeName",
});
console.log(`${TABLE}: ${stores.length} store(s)${WRITE ? "" : " (dry run; pass --write to apply)"}`);

let listed = 0;
let already = 0;
for (const { storeId, storeName } of stores) {
  const pending = await queryAll({
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
    FilterExpression: "storeOrderStatus = :pending",
    ExpressionAttributeValues: { ":pk": `STORE#${storeId}`, ":sk": "ORDER#", ":pending": "PENDING_PAYMENT" },
    ProjectionExpression: "sk, storeOrderId, storeOrderCreatedAt",
  });
  for (const o of pending) {
    const row = { pk: "APP_PENDING_ORDER", sk: o.sk, storeId, orderId: o.storeOrderId, orderSk: o.sk };
    const label = `${storeName} (${storeId}): order ${o.storeOrderId} from ${new Date(o.storeOrderCreatedAt).toISOString()}`;
    if (!WRITE) {
      console.log(`  would list: ${label}`);
      listed++;
      continue;
    }
    try {
      await ddb.send(new PutCommand({ TableName: TABLE, Item: row, ConditionExpression: "attribute_not_exists(pk)" }));
      console.log(`  listed: ${label}`);
      listed++;
    } catch (e) {
      if (e?.name !== "ConditionalCheckFailedException") throw e;
      already++;
    }
  }
}
console.log(`${WRITE ? "Listed" : "Would list"} ${listed} pending order(s)${already ? `; ${already} already listed` : ""}.`);
