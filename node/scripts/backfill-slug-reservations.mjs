// One-off (progress.md 1.8): reserve SLUG#<slug> for every store created before reservations
// existed. Safe to run more than once: a slug already held by the same store is left as is.
//
//   npm run build                                       # the slug rule is read from dist/
//   node scripts/backfill-slug-reservations.mjs         # dry run against ceseelia_dev
//   node scripts/backfill-slug-reservations.mjs --write # apply
//   DB_TABLE_NAME=ceseelia_prod node scripts/backfill-slug-reservations.mjs --write
//
// Stores whose slug is malformed, reserved or already held by another store are listed and
// skipped; fix those with Admin › Stores › Edit (which reserves the new slug).
import { createRequire } from "node:module";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const require = createRequire(import.meta.url);
const { isValidSlug } = require("../dist/constants/slug.js");

const TABLE = process.env.DB_TABLE_NAME || "ceseelia_dev";
const WRITE = process.argv.includes("--write");
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

const stores = [];
let ExclusiveStartKey;
do {
  const page = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: { ":pk": "APP_STORE", ":sk": "STORE#" },
      ExclusiveStartKey,
    })
  );
  stores.push(...(page.Items ?? []));
  ExclusiveStartKey = page.LastEvaluatedKey;
} while (ExclusiveStartKey);

console.log(`${TABLE}: ${stores.length} store(s)${WRITE ? "" : " (dry run; pass --write to apply)"}`);
const seen = new Map();
let problems = 0;
for (const { storeId, storeName, storeSlug } of stores) {
  const label = `${storeName} (${storeId}) "${storeSlug}"`;
  if (!isValidSlug(storeSlug)) {
    console.log(`  SKIP invalid/reserved slug: ${label}`);
    problems++;
    continue;
  }
  if (seen.has(storeSlug)) {
    console.log(`  SKIP duplicate of ${seen.get(storeSlug)}: ${label}`);
    problems++;
    continue;
  }
  seen.set(storeSlug, storeId);
  if (!WRITE) {
    console.log(`  would reserve: ${label}`);
    continue;
  }
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { pk: `SLUG#${storeSlug}`, sk: "STORE", storeId, createdAt: Date.now() },
        ConditionExpression: "attribute_not_exists(pk) OR storeId = :storeId",
        ExpressionAttributeValues: { ":storeId": storeId },
      })
    );
    console.log(`  reserved: ${label}`);
  } catch (e) {
    if (e.name !== "ConditionalCheckFailedException") throw e;
    console.log(`  SKIP held by another store: ${label}`);
    problems++;
  }
}
console.log(problems ? `${problems} store(s) need a new slug.` : "Done, no problems.");
