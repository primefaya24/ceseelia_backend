// One-off (progress.md 2.5): turn each item's old single decimal `storeItemPrice` (65.5) into
// `storeItemPrices` in minor units, under the store's default currency ({ USD: 6550 }), and
// remove the old field. Items that already have storeItemPrices are left alone, so it's safe to
// run more than once. The merchant adds prices for the store's other currencies themselves.
//
//   node scripts/migrate-item-prices.mjs          # dry run against ceseelia_dev
//   node scripts/migrate-item-prices.mjs --write  # apply
//   DB_TABLE_NAME=ceseelia_prod node scripts/migrate-item-prices.mjs --write
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.DB_TABLE_NAME || "ceseelia_dev";
const WRITE = process.argv.includes("--write");
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

async function queryAll(pk, skPrefix) {
  const rows = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeValues: { ":pk": pk, ":sk": skPrefix },
        ConsistentRead: true,
        ExclusiveStartKey,
      })
    );
    rows.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
}

const stores = await queryAll("APP_STORE", "STORE#");
console.log(`${TABLE}: ${stores.length} store(s)${WRITE ? "" : " (dry run; pass --write to apply)"}`);
let changed = 0;
let skipped = 0;
for (const { storeId, storeName } of stores) {
  const pk = `STORE#${storeId}`;
  const { Item: settings } = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk, sk: "SETTINGS" }, ConsistentRead: true })
  );
  const code = settings?.currencies?.find((c) => c.currencyIsDefault)?.currencyCode ?? "USD";
  const items = await queryAll(pk, "ITEM#");
  console.log(`${storeName} (${storeId}): ${items.length} item(s), default currency ${code}`);
  for (const item of items) {
    if (item.storeItemPrices) {
      skipped++;
      continue;
    }
    const old = typeof item.storeItemPrice === "number" ? item.storeItemPrice : 0;
    const prices = { [code]: Math.round(old * 100) };
    changed++;
    console.log(`  "${item.storeItemName}": ${old} -> ${JSON.stringify(prices)}${WRITE ? "" : " (not written)"}`);
    if (WRITE) {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { pk, sk: item.sk },
          UpdateExpression: "SET storeItemPrices = :p REMOVE storeItemPrice",
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(storeItemPrices)",
          ExpressionAttributeValues: { ":p": prices },
        })
      );
    }
  }
}
console.log(
  changed ? `${changed} item(s) ${WRITE ? "migrated" : "would change"}; ${skipped} already done.` : `Nothing to do; ${skipped} already done.`
);
