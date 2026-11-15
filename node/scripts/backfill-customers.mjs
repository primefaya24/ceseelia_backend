// One-off (L.7 / 7.1, 2026-11-15): builds Store › Customers from orders paid before customer
// records existed. Uses the API's own `recordCustomerOrder` (from dist/, so run `npm run build`
// first), which is idempotent: an order already counted is left alone, so it's safe to run again
// and while the API is running. Prints counts and store ids only (no shopper details).
//
//   node scripts/backfill-customers.mjs          # dry run against ceseelia_dev
//   node scripts/backfill-customers.mjs --write  # apply
//   DB_TABLE_NAME=ceseelia_prod node scripts/backfill-customers.mjs --write
import { createRequire } from "module";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

process.env.DB_TABLE_NAME ||= "ceseelia_dev";
const TABLE = process.env.DB_TABLE_NAME;
const WRITE = process.argv.includes("--write");
const require = createRequire(import.meta.url);
const { recordCustomerOrder } = require("../dist/layers/aws/dynamodb/dynamo-entities/customer");
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
  ProjectionExpression: "storeId",
});
console.log(`${TABLE}: ${stores.length} store(s)${WRITE ? "" : " (dry run; pass --write to apply)"}`);

const totals = { ADDED: 0, UPDATED: 0, UNCHANGED: 0, SKIPPED: 0, paid: 0 };
for (const { storeId } of stores) {
  const orders = await queryAll({
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
    FilterExpression: "attribute_exists(storeOrderPaidAt) AND NOT storeOrderStatus IN (:p, :c)",
    ExpressionAttributeValues: { ":pk": `STORE#${storeId}`, ":sk": "ORDER#", ":p": "PENDING_PAYMENT", ":c": "CANCELLED" },
  });
  if (!orders.length) continue;
  totals.paid += orders.length;
  if (!WRITE) {
    console.log(`  ${storeId}: ${orders.length} paid order(s) would be recorded`);
    continue;
  }
  const seen = { ADDED: 0, UPDATED: 0, UNCHANGED: 0, SKIPPED: 0 };
  for (const { pk: _pk, sk: _sk, ...order } of orders) seen[await recordCustomerOrder(order)]++;
  console.log(`  ${storeId}: ${JSON.stringify(seen)}`);
  for (const k of Object.keys(seen)) totals[k] += seen[k];
}
console.log(WRITE ? `done: ${JSON.stringify(totals)}` : `${totals.paid} paid order(s) in all`);
