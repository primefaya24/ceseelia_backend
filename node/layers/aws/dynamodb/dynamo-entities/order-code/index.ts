// Order codes people read: the store's prefix, then a number counting up per store (UX-B).
//
//   STORE#<storeId> / ORDER_CODE         { prefix, n }  the store's prefix and its last number
//   ORDER_CODE_PREFIX#<prefix> / STORE   { storeId }    the prefix's owner: no two stores share one
//
// A store gets its prefix the first time it takes an order (both rows in one transaction, each
// conditional on not existing), then every order raises `n` atomically, so a code can't repeat in
// a store, and with unique prefixes it can't repeat on the platform. The prefix never changes,
// even when the store is renamed, and stays reserved after a store is deleted (never reused).
// Codes from before UX-B (6 random characters) stay on their orders.
import { randomInt } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../../constants";
import { DB_TABLE_NAME } from "../../../../../config";

const dynamoDbDocumentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: appConstants.DEFAULT_REGION })
);
const TABLE = DB_TABLE_NAME;

/* The first order is 1001: a new store's first sale doesn't read as "#1". */
export const ORDER_NUMBER_START = 1000;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const orderCodeCounterKey = (storeId: string) => ({
  pk: `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}`,
  sk: "ORDER_CODE",
});
export const orderCodePrefixKey = (prefix: string) => ({ pk: `ORDER_CODE_PREFIX#${prefix}`, sk: "STORE" });

export const formatOrderCode = (prefix: string, n: number) => `${prefix}-${n}`;

/* The name's words as plain capital letters: "Pressed By PMerch 1" → ["PRESSED", "BY", "PMERCH"]. */
function nameWords(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .map((w) => w.replace(/[^A-Z]/g, ""))
    .filter(Boolean);
}

/*
 * Prefixes to try, best first: 2 letters (the first two words' initials, then the first word's
 * first two letters, then other pairs from the name), then 3 letters the same way. Random ones
 * follow when the name runs out (or has no letters).
 */
export function prefixCandidates(name: string): string[] {
  const words = nameWords(name);
  const letters = words.join("");
  const out: string[] = [];
  const add = (p: string) => {
    if (/^[A-Z]{2,4}$/.test(p) && !out.includes(p)) out.push(p);
  };
  for (const size of [2, 3]) {
    if (words.length >= size) add(words.slice(0, size).map((w) => w[0]).join(""));
    add(letters.slice(0, size));
    // The first letter with each later letter (or pair), in the name's order.
    for (let i = 1; i < letters.length && out.length < 40; i++) {
      if (size === 2) add(letters[0] + letters[i]);
      else for (let j = i + 1; j < letters.length && out.length < 40; j++) add(letters[0] + letters[i] + letters[j]);
    }
  }
  return out;
}

const randomPrefix = (size: number) =>
  Array.from({ length: size }, () => LETTERS[randomInt(LETTERS.length)]).join("");

const isCancelled = (e: unknown) => (e as { name?: string }).name === "TransactionCanceledException";
const cancelReasons = (e: unknown) =>
  ((e as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).map((r) => r?.Code);

async function readPrefix(storeId: string): Promise<string | null> {
  const r = await dynamoDbDocumentClient.send(
    new GetCommand({ TableName: TABLE, Key: orderCodeCounterKey(storeId), ConsistentRead: true })
  );
  const prefix = r.Item?.prefix;
  return typeof prefix === "string" && /^[A-Z]{2,4}$/.test(prefix) ? prefix : null;
}

/* Reserve `prefix` for the store. "taken": another store has it; "exists": this store already has one. */
async function tryReserve(storeId: string, prefix: string): Promise<"ok" | "taken" | "exists"> {
  try {
    await dynamoDbDocumentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: { ...orderCodePrefixKey(prefix), storeId, createdAt: Date.now() },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: { ...orderCodeCounterKey(storeId), prefix, n: ORDER_NUMBER_START, createdAt: Date.now() },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      })
    );
    return "ok";
  } catch (e) {
    if (!isCancelled(e)) throw e;
    const [prefixReason, counterReason] = cancelReasons(e);
    if (counterReason === "ConditionalCheckFailed") return "exists";
    if (prefixReason === "ConditionalCheckFailed") return "taken";
    throw e;
  }
}

/* The store's prefix, reserving one from its name the first time. */
export async function ensureStorePrefix(storeId: string, storeName: string): Promise<string> {
  const existing = await readPrefix(storeId);
  if (existing) return existing;
  const tries = [
    ...prefixCandidates(storeName),
    ...Array.from({ length: 10 }, () => randomPrefix(3)),
    ...Array.from({ length: 10 }, () => randomPrefix(4)),
  ];
  for (const prefix of tries) {
    const result = await tryReserve(storeId, prefix);
    if (result === "ok") return prefix;
    if (result === "exists") {
      // Another order for this store reserved one at the same moment: use it.
      const now = await readPrefix(storeId);
      if (now) return now;
      throw new Error(`Order code counter for store ${storeId} has no prefix`);
    }
  }
  throw new Error(`No free order code prefix for store ${storeId}`);
}

/* The next order code for a store, e.g. "PB-1001". Never the same twice. */
export async function nextOrderCode(storeId: string, storeName: string): Promise<string> {
  const prefix = await ensureStorePrefix(storeId, storeName);
  const r = await dynamoDbDocumentClient.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: orderCodeCounterKey(storeId),
      UpdateExpression: "ADD n :one",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":one": 1 },
      ReturnValues: "UPDATED_NEW",
    })
  );
  const n = Number(r.Attributes?.n);
  if (!Number.isInteger(n) || n <= ORDER_NUMBER_START) throw new Error(`Bad order number for store ${storeId}`);
  return formatOrderCode(prefix, n);
}
