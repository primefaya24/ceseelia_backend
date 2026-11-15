// One-off (L.7 / 7.3, 2026-11-15): store settings saved by the older webapp say
// REWARDS_REDEMPTION_DOLLAR / REWARDS_REDEMPTION_DISCOUNT; the one spelling is now
// POINTS_TO_MONEY / POINTS_TO_DISCOUNT. The API reads both, so this is tidying, safe to run again.
// Conditional on the old value, so a merchant saving at the same moment wins. Prints store ids only.
//
//   node scripts/normalize-rewards-method.mjs          # dry run against ceseelia_dev
//   node scripts/normalize-rewards-method.mjs --write  # apply
//   DB_TABLE_NAME=ceseelia_prod node scripts/normalize-rewards-method.mjs --write
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.DB_TABLE_NAME || "ceseelia_dev";
const WRITE = process.argv.includes("--write");
const MAP = { REWARDS_REDEMPTION_DOLLAR: "POINTS_TO_MONEY", REWARDS_REDEMPTION_DISCOUNT: "POINTS_TO_DISCOUNT" };
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

const stores = [];
let ExclusiveStartKey;
do {
  const page = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: { ":pk": "APP_STORE", ":sk": "STORE#" },
      ProjectionExpression: "storeId",
      ExclusiveStartKey,
    })
  );
  stores.push(...(page.Items ?? []));
  ExclusiveStartKey = page.LastEvaluatedKey;
} while (ExclusiveStartKey);
console.log(`${TABLE}: ${stores.length} store(s)${WRITE ? "" : " (dry run; pass --write to apply)"}`);

let changed = 0;
for (const { storeId } of stores) {
  const Key = { pk: `STORE#${storeId}`, sk: "SETTINGS" };
  const row = (await ddb.send(new GetCommand({ TableName: TABLE, Key, ProjectionExpression: "purchaseRewards" }))).Item;
  const old = row?.purchaseRewards?.redemptionMethod;
  if (!MAP[old]) continue;
  changed++;
  console.log(`  ${storeId}: ${old} → ${MAP[old]}`);
  if (!WRITE) continue;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key,
        UpdateExpression: "SET purchaseRewards.redemptionMethod = :new",
        ConditionExpression: "purchaseRewards.redemptionMethod = :old",
        ExpressionAttributeValues: { ":new": MAP[old], ":old": old },
      })
    );
  } catch (e) {
    if (e?.name !== "ConditionalCheckFailedException") throw e;
    console.log(`  ${storeId}: changed meanwhile, left alone`);
  }
}
console.log(`${changed} store(s) ${WRITE ? "updated" : "would be updated"}`);
