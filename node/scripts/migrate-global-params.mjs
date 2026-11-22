// One-off (progress.md Stage R.13): turn the parameters typed on each item (before Stage R)
// into store parameters (`STORE#<id> / PARAM#<paramId>`) and link the items to them.
//
// Per store: identical item params (same name, type, required and options in the same order)
// become one store parameter. Two different ones with the same name get a tag (#2, #3…), since
// a store's parameter keys are unique. Nothing the shopper sees changes: names and options stay
// as they are, and a single choice keeps its stock and price per option
// (`storeParamHasVariants: true`, the behaviour before Stage R), so variant rows are untouched.
// Items are written only if their params are still what was read. Safe to run again: linked
// params are skipped, and a store parameter with the same key and content is reused.
//
//   node scripts/migrate-global-params.mjs            # dry run against ceseelia_dev
//   node scripts/migrate-global-params.mjs --write    # apply
//   DB_TABLE_NAME=ceseelia_prod node scripts/migrate-global-params.mjs [--write] [--store <storeId>]
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

const TABLE = process.env.DB_TABLE_NAME || "ceseelia_dev";
const WRITE = process.argv.includes("--write");
const ONLY = process.argv.includes("--store") ? process.argv[process.argv.indexOf("--store") + 1] : null;
const MAX_STORE_PARAMS = 50;
const MAX_OPTIONS = 30;
const MAX_LABEL = 40;
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

const clean = (s) => (typeof s === "string" ? s.trim() : "");
const keyOf = (d) => (d.storeParamTag ? `${d.storeParamName}#${d.storeParamTag}` : d.storeParamName).toLowerCase();

/** The store parameter an item-only param becomes (same rules as BE `cleanParamDef`). */
function defFromItemParam(p) {
  const type = p.storeParamType === "MULTI_SELECT" ? "MULTI_SELECT" : "SINGLE_SELECT";
  const options = (p.storeParamOptions ?? []).map(clean).filter((o) => o.length > 0);
  return {
    storeParamName: clean(p.storeParamLabel),
    storeParamTag: "",
    storeParamType: type,
    // A single choice made variants before Stage R (missing flag = on), and was always required.
    storeParamHasVariants: type === "SINGLE_SELECT" && p.storeParamHasVariants !== false,
    storeParamIsMandatory: type === "SINGLE_SELECT" && p.storeParamHasVariants !== false ? true : !!p.storeParamIsMandatory,
    storeParamOptions: options,
  };
}

const sameContent = (a, b) =>
  a.storeParamName === b.storeParamName &&
  a.storeParamType === b.storeParamType &&
  a.storeParamHasVariants === b.storeParamHasVariants &&
  a.storeParamIsMandatory === b.storeParamIsMandatory &&
  JSON.stringify(a.storeParamOptions) === JSON.stringify(b.storeParamOptions);

/** Why a param can't be a store parameter as it is ('' = it can). */
function problem(d) {
  if (!d.storeParamName || d.storeParamName.length > MAX_LABEL) return "no name";
  if (d.storeParamName.includes("#")) return '"#" in the name';
  if (d.storeParamOptions.length === 0) return "no options";
  if (d.storeParamOptions.length > MAX_OPTIONS) return "too many options";
  if (new Set(d.storeParamOptions.map((o) => o.toLowerCase())).size !== d.storeParamOptions.length) return "repeated options";
  return "";
}

/** Same as BE `itemParamFromDef`. */
const itemCopy = (d) => ({
  storeParamId: d.storeParamId,
  storeParamLabel: d.storeParamName,
  storeParamType: d.storeParamType,
  storeParamIsMandatory: d.storeParamHasVariants ? true : d.storeParamIsMandatory,
  storeParamOptions: [...d.storeParamOptions],
  storeParamHasVariants: d.storeParamHasVariants,
});

const stores = (await queryAll("APP_STORE", "STORE#")).filter((s) => !ONLY || s.storeId === ONLY);
console.log(`${TABLE}: ${stores.length} store(s)${WRITE ? "" : " (dry run; pass --write to apply)"}`);
let created = 0;
let linkedItems = 0;
let left = 0;
for (const { storeId, storeName } of stores) {
  const pk = `STORE#${storeId}`;
  const defs = (await queryAll(pk, "PARAM#")).map(({ pk: _p, sk: _s, ...d }) => d);
  const items = await queryAll(pk, "ITEM#");
  const legacyCount = items.reduce((n, i) => n + (i.storeItemCustomParams ?? []).filter((p) => !p.storeParamId).length, 0);
  if (legacyCount === 0) continue;
  console.log(`${storeName} (${storeId}): ${items.length} item(s), ${legacyCount} item-only param(s), ${defs.length} store param(s)`);

  /** The store parameter for this content: an existing one, or a new one with a free key. */
  const findOrMake = (wanted) => {
    const same = defs.find((d) => sameContent(d, wanted) && d.storeParamTag === "");
    if (same) return { def: same, isNew: false };
    const sameTagged = defs.find((d) => sameContent(d, wanted));
    if (sameTagged) return { def: sameTagged, isNew: false };
    if (defs.length >= MAX_STORE_PARAMS) return null;
    const taken = new Set(defs.map(keyOf));
    let tag = "";
    for (let n = 2; taken.has(keyOf({ ...wanted, storeParamTag: tag })); n++) tag = String(n);
    const def = { ...wanted, storeParamTag: tag, storeParamId: ulid(), storeParamUpdatedAt: Date.now() };
    defs.push(def);
    return { def, isNew: true };
  };

  const newDefs = [];
  const itemWrites = [];
  for (const item of items) {
    const before = item.storeItemCustomParams ?? [];
    if (!before.some((p) => !p.storeParamId)) continue;
    const after = before.map((p) => {
      if (p.storeParamId) return p;
      const wanted = defFromItemParam(p);
      const why = problem(wanted);
      if (why) {
        left++;
        console.log(`  "${item.storeItemName}": "${p.storeParamLabel}" left on the item (${why})`);
        return p;
      }
      const found = findOrMake(wanted);
      if (!found) {
        left++;
        console.log(`  "${item.storeItemName}": "${p.storeParamLabel}" left on the item (store has ${MAX_STORE_PARAMS} parameters)`);
        return p;
      }
      if (found.isNew) {
        newDefs.push(found.def);
        const d = found.def;
        console.log(
          `  + ${d.storeParamName}${d.storeParamTag ? " #" + d.storeParamTag : ""}: ${d.storeParamType}` +
            `${d.storeParamHasVariants ? ", stock & price per option" : ""}${d.storeParamIsMandatory ? ", required" : ""}` +
            `, ${d.storeParamOptions.length} option(s): ${d.storeParamOptions.join(", ")}`
        );
      }
      return itemCopy(found.def);
    });
    if (JSON.stringify(after) !== JSON.stringify(before)) itemWrites.push({ item, before, after });
  }

  for (const d of newDefs) {
    created++;
    if (WRITE) {
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: { pk, sk: `PARAM#${d.storeParamId}`, ...d },
          ConditionExpression: "attribute_not_exists(pk)",
        })
      );
    }
  }
  for (const { item, before, after } of itemWrites) {
    linkedItems++;
    console.log(`  "${item.storeItemName}": linked${WRITE ? "" : " (not written)"}`);
    if (WRITE) {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { pk, sk: item.sk },
          UpdateExpression: "SET storeItemCustomParams = :after",
          ConditionExpression: "attribute_exists(pk) AND storeItemCustomParams = :before",
          ExpressionAttributeValues: { ":after": after, ":before": before },
        })
      );
    }
  }
}
console.log(
  `${created} store parameter(s) ${WRITE ? "created" : "to create"}, ${linkedItems} item(s) ${WRITE ? "linked" : "to link"}` +
    (left ? `, ${left} param(s) left on their items (see above)` : "") +
    "."
);
