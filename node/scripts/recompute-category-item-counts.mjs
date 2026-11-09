// One-off (progress.md 2.1): set every category's storeCategoryItemCount to the number of items
// that point at it. Before 2.1 the count was reset to 0 on every category save and never
// changed on item writes. Safe to run more than once.
//
//   node scripts/recompute-category-item-counts.mjs          # dry run against ceseelia_dev
//   node scripts/recompute-category-item-counts.mjs --write  # apply
//   DB_TABLE_NAME=ceseelia_prod node scripts/recompute-category-item-counts.mjs --write
//
// Run it when nobody is editing inventory: an item saved between the count and the write could
// leave that one category off by one (running the script again fixes it).
// Items whose category no longer exists (left by category deletes before 2.2) are listed.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

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
for (const { storeId, storeName } of stores) {
  const pk = `STORE#${storeId}`;
  const [categories, items] = await Promise.all([queryAll(pk, "CATEGORY#"), queryAll(pk, "ITEM#")]);
  const counts = new Map(categories.map((c) => [c.sk.slice("CATEGORY#".length), 0]));
  const orphans = [];
  for (const item of items) {
    const c = item.storeItemCategoryId;
    if (counts.has(c)) counts.set(c, counts.get(c) + 1);
    else orphans.push(item);
  }
  console.log(`${storeName} (${storeId}): ${categories.length} categories, ${items.length} items`);
  for (const category of categories) {
    const id = category.sk.slice("CATEGORY#".length);
    const was = category.storeCategoryItemCount;
    const now = counts.get(id);
    if (was === now) continue;
    changed++;
    console.log(`  ${category.storeCategoryName}: ${was} -> ${now}${WRITE ? "" : " (not written)"}`);
    if (WRITE) {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { pk, sk: category.sk },
          UpdateExpression: "SET storeCategoryItemCount = :n",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ":n": now },
        })
      );
    }
  }
  for (const o of orphans) {
    console.log(`  ORPHAN item "${o.storeItemName}" (${o.sk}) -> missing category ${o.storeItemCategoryId}`);
  }
}
console.log(changed ? `${changed} count(s) ${WRITE ? "fixed" : "would change"}.` : "All counts already right.");
