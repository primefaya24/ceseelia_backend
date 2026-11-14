// One-off (owner, 2026-11-13: no Free plan). Every store saved on the old FREE plan, or with no
// lifecycle at all (before P.2), gets the lifecycle the API now reads for it:
//   plan FREE / unknown / missing → NONE
//   LIVE with no plan → DRAFT, pausedReason PLAN_ENDED (it isn't open to shoppers until it
//     goes live on Spark or Nova)
//   pausedReason FREE_PLAN_IN_USE → dropped
// Until a row is rewritten its conditional writes (Go Live, billing, admin plan) fail with
// STATUS_CHANGED, because the stored status differs from the one read. Safe to run again: rows
// already in the new shape are left alone.
//
//   npm run build                               # normalizeStoreLifecycle is read from dist/
//   node scripts/migrate-free-plan.mjs          # dry run against ceseelia_dev
//   node scripts/migrate-free-plan.mjs --write  # apply
//   DB_TABLE_NAME=ceseelia_prod node scripts/migrate-free-plan.mjs --write
import { createRequire } from "node:module";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const require = createRequire(import.meta.url);
const { normalizeStoreLifecycle } = require("../dist/layers/core/interfaces/store/index.js");

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

/** Same fields and values; DynamoDB hands maps back with their keys in its own order. */
const sorted = (v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]))
    : v;
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

console.log(`${TABLE}: ${stores.length} store(s)${WRITE ? "" : " (dry run; pass --write to apply)"}`);
let changed = 0;
let skipped = 0;
for (const { storeId, storeName } of stores) {
  const key = { pk: `STORE#${storeId}`, sk: "SETTINGS" };
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: key, ProjectionExpression: "lifecycle" }));
  const raw = Item?.lifecycle;
  const next = normalizeStoreLifecycle(raw);
  if (raw && same(raw, next)) continue;
  const label = `${storeName} (${storeId}): ${raw ? `${raw.status}/${raw.plan ?? "-"}` : "no lifecycle"} → ${next.status}/${next.plan}`;
  changed++;
  if (!WRITE) {
    console.log(`  would update: ${label}`);
    continue;
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: key,
        UpdateExpression: "SET #lc = :lc",
        ConditionExpression: raw
          ? "attribute_exists(pk) AND #lc.#st = :st AND #lc.#pl = :pl"
          : "attribute_exists(pk) AND attribute_not_exists(#lc)",
        ExpressionAttributeNames: raw ? { "#lc": "lifecycle", "#st": "status", "#pl": "plan" } : { "#lc": "lifecycle" },
        ExpressionAttributeValues: raw ? { ":lc": next, ":st": raw.status, ":pl": raw.plan } : { ":lc": next },
      })
    );
    console.log(`  updated: ${label}`);
  } catch (e) {
    if (e.name !== "ConditionalCheckFailedException") throw e;
    console.log(`  SKIP changed meanwhile (run again): ${label}`);
    skipped++;
  }
}
console.log(`${changed} store(s) ${WRITE ? "updated" : "to update"}${skipped ? `, ${skipped} skipped` : ""}.`);
