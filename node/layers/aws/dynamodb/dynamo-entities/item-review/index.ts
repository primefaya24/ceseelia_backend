import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../../constants";
import { DB_TABLE_NAME } from "../../../../../config";
import { StoreItemReview } from "../../../../core/interfaces/store";

/*
 * The AI check of a live store's items (progress.md L.2):
 *   `APP_ITEM_CHECK  / STORE#<storeId>#ITEM#<itemId>`  { storeId, itemId, dueAt }
 *       an item saved on a store: create-item (re)writes it with dueAt = now + a few minutes, so
 *       a burst of edits is checked once; the item sweep checks it when due and removes it.
 *   `APP_ITEM_REVIEW / STORE#<storeId>#ITEM#<itemId>`  { storeId, itemId, storeName, itemName,
 *       imageUri, reasons, flaggedAt }   the admin queue of hidden items.
 * The item's own `storeItemReview` / `storeItemCheckedHash` are written only here, never by
 * create-item (its update names its own fields).
 */
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: appConstants.DEFAULT_REGION }));
const TABLE = DB_TABLE_NAME;

export const ITEM_CHECK_PK = "APP_ITEM_CHECK";
export const ITEM_REVIEW_PK = "APP_ITEM_REVIEW";
const rowSk = (storeId: string, itemId: string) => `STORE#${storeId}#ITEM#${itemId}`;
export const itemCheckKey = (storeId: string, itemId: string) => ({ pk: ITEM_CHECK_PK, sk: rowSk(storeId, itemId) });
export const itemReviewKey = (storeId: string, itemId: string) => ({ pk: ITEM_REVIEW_PK, sk: rowSk(storeId, itemId) });
const itemKey = (storeId: string, itemId: string) => ({
  pk: `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}`,
  sk: `${appConstants.DYNAMO_ENTITY_ITEM}#${itemId}`,
});

const isConditionFailure = (e: unknown) => {
  const name = (e as { name?: string })?.name;
  return name === "ConditionalCheckFailedException" || name === "TransactionCanceledException";
};

export interface ItemCheckRow {
  storeId: string;
  itemId: string;
  dueAt: number;
}

export interface ItemReviewQueueEntry {
  storeId: string;
  itemId: string;
  storeName: string;
  itemName: string;
  imageUri: string;
  reasons: string[];
  flaggedAt: number;
}

/* Check this item once nothing has changed on it for `delayMs` (each save pushes it back). */
export async function queueItemCheck(storeId: string, itemId: string, delayMs: number, now = Date.now()): Promise<void> {
  await ddb.send(
    new PutCommand({ TableName: TABLE, Item: { ...itemCheckKey(storeId, itemId), storeId, itemId, dueAt: now + delayMs } })
  );
}

export async function listDueItemChecks(now: number, limit: number): Promise<ItemCheckRow[]> {
  const out: ItemCheckRow[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk",
        FilterExpression: "dueAt <= :now",
        ExpressionAttributeValues: { ":pk": ITEM_CHECK_PK, ":now": now },
        ExclusiveStartKey: start,
      })
    );
    for (const i of r.Items ?? []) {
      out.push({ storeId: String(i.storeId), itemId: String(i.itemId), dueAt: Number(i.dueAt) });
      if (out.length >= limit) return out;
    }
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}

/* Done with this check, unless the item was saved again meanwhile (a later dueAt): then it stays. */
export async function deleteItemCheck(row: ItemCheckRow): Promise<void> {
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: itemCheckKey(row.storeId, row.itemId),
        ConditionExpression: "dueAt = :d",
        ExpressionAttributeValues: { ":d": row.dueAt },
      })
    );
  } catch (e) {
    if (!isConditionFailure(e)) throw e;
  }
}

/*
 * Saves an item check's outcome on the item, and keeps the admin queue in step:
 *   review = a review   → storeItemReview set; queued for admins when FLAGGED
 *   review = null       → storeItemReview removed (an earlier flag cleared), off the queue
 *   review = undefined  → storeItemReview left as it is (passed; APPROVED or never flagged)
 * Returns false when the item no longer exists.
 */
export async function saveItemCheckResult(opts: {
  storeId: string;
  itemId: string;
  hash: string;
  review: StoreItemReview | null | undefined;
  queue?: Omit<ItemReviewQueueEntry, "storeId" | "itemId" | "reasons" | "flaggedAt">;
}): Promise<boolean> {
  const { storeId, itemId, hash, review } = opts;
  const values: Record<string, unknown> = { ":h": hash };
  let update = "SET storeItemCheckedHash = :h";
  if (review) {
    values[":r"] = review;
    update += ", storeItemReview = :r";
  } else if (review === null) {
    update += " REMOVE storeItemReview";
  }
  const items: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
    {
      Update: {
        TableName: TABLE,
        Key: itemKey(storeId, itemId),
        UpdateExpression: update,
        ExpressionAttributeValues: values,
        ConditionExpression: "attribute_exists(pk)",
      },
    },
  ];
  if (review?.status === "FLAGGED") {
    items.push({
      Put: {
        TableName: TABLE,
        Item: {
          ...itemReviewKey(storeId, itemId),
          storeId,
          itemId,
          storeName: opts.queue?.storeName ?? "",
          itemName: opts.queue?.itemName ?? "",
          imageUri: opts.queue?.imageUri ?? "",
          reasons: review.reasons,
          flaggedAt: review.flaggedAt,
        },
      },
    });
  } else if (review === null) {
    items.push({ Delete: { TableName: TABLE, Key: itemReviewKey(storeId, itemId) } });
  }
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  } catch (e) {
    if (isConditionFailure(e)) return false;
    throw e;
  }
}

export async function listItemReviewQueue(): Promise<ItemReviewQueueEntry[]> {
  const out: ItemReviewQueueEntry[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": ITEM_REVIEW_PK },
        ExclusiveStartKey: start,
      })
    );
    for (const i of r.Items ?? []) {
      out.push({
        storeId: String(i.storeId),
        itemId: String(i.itemId),
        storeName: String(i.storeName ?? ""),
        itemName: String(i.itemName ?? ""),
        imageUri: String(i.imageUri ?? ""),
        reasons: Array.isArray(i.reasons) ? i.reasons.map(String) : [],
        flaggedAt: Number(i.flaggedAt ?? 0),
      });
    }
    start = r.LastEvaluatedKey;
  } while (start);
  return out.sort((a, b) => a.flaggedAt - b.flaggedAt);
}

export class ItemReviewChangedError extends Error {
  constructor() {
    super("This item isn't waiting for review any more");
    this.name = "ItemReviewChangedError";
  }
}

/* An admin's decision on a hidden item: APPROVED shows it again, REJECTED keeps it hidden. */
export async function decideItemReview(
  storeId: string,
  itemId: string,
  decision: "APPROVED" | "REJECTED",
  now = Date.now()
): Promise<void> {
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: itemKey(storeId, itemId),
              UpdateExpression: "SET storeItemReview.#s = :s, storeItemReview.decidedAt = :t",
              ConditionExpression: "attribute_exists(pk) AND storeItemReview.#s = :flagged",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":s": decision, ":t": now, ":flagged": "FLAGGED" },
            },
          },
          { Delete: { TableName: TABLE, Key: itemReviewKey(storeId, itemId) } },
        ],
      })
    );
  } catch (e) {
    if (isConditionFailure(e)) throw new ItemReviewChangedError();
    throw e;
  }
}

/* An item deleted while queued: take it off the admin queue too. */
export async function removeItemReviewRow(storeId: string, itemId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: itemReviewKey(storeId, itemId) }));
}
