// Store slug reservations (progress.md 1.8).
//
// pk `SLUG#<slug>`, sk `STORE`, attribute `storeId`. A slug belongs to the store whose id is on
// its row. Rows are only written inside the store create / rename transactions (conditional on
// the slug being free or already ours) and removed on rename and store delete, so the store
// overview's `storeSlug` and this row always agree.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../../constants";
import { DB_TABLE_NAME } from "../../../../../config";

const dynamoDbDocumentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: appConstants.DEFAULT_REGION })
);

export const SLUG_TAKEN_MESSAGE = "That slug is already taken.";

/* Thrown when another store already holds the slug. Routes map it to 409. */
export class SlugTakenError extends Error {
  constructor(public readonly slug: string) {
    super(SLUG_TAKEN_MESSAGE);
    this.name = "SlugTakenError";
  }
}

export function slugKey(slug: string): { pk: string; sk: string } {
  return { pk: appConstants.DYNAMO_ENTITY_SLUG + "#" + slug, sk: appConstants.DYNAMO_ENTITY_STORE };
}

/* The id of the store holding `slug`, or null. */
export async function getSlugOwner(slug: string): Promise<string | null> {
  const result = await dynamoDbDocumentClient.send(
    new GetCommand({ TableName: DB_TABLE_NAME, Key: slugKey(slug), ConsistentRead: true })
  );
  return (result.Item?.storeId as string | undefined) ?? null;
}

/*
 * Transaction parts. `reserveSlug` succeeds when the slug is free or already ours (so re-saving
 * the same slug, or a store reserved by the backfill, still works); `releaseSlug` only removes it
 * while it's still ours.
 */
export function reserveSlugPut(slug: string, storeId: string) {
  return {
    Put: {
      TableName: DB_TABLE_NAME,
      Item: { ...slugKey(slug), storeId, createdAt: Date.now() },
      ConditionExpression: "attribute_not_exists(pk) OR storeId = :storeId",
      ExpressionAttributeValues: { ":storeId": storeId },
    },
  };
}

export function releaseSlugDelete(slug: string, storeId: string) {
  return {
    Delete: {
      TableName: DB_TABLE_NAME,
      Key: slugKey(slug),
      ConditionExpression: "storeId = :storeId",
      ExpressionAttributeValues: { ":storeId": storeId },
    },
  };
}

/* True when a cancelled transaction failed its condition at position `index`. */
export function transactionFailedAt(e: unknown, index: number): boolean {
  const err = e as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return (
    err?.name === "TransactionCanceledException" &&
    err.CancellationReasons?.[index]?.Code === "ConditionalCheckFailed"
  );
}
