import { createHash } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../../constants";
import { DB_TABLE_NAME } from "../../../../../config";
import { queryAllWithPrefix } from "../../dynamo-query";

/*
 * Web push subscriptions (progress.md L.5 / BE 6.7), one per browser a user turned
 * notifications on in:
 *   `USER#<userId> / PUSH#<sha256(endpoint), 32 hex>`  { endpoint, p256dh, auth, createdAt }
 * The endpoint is the push service's URL for that browser (it is the address, so it's kept
 * as a secret-ish value: never logged). A user keeps at most MAX_PUSH_SUBSCRIPTIONS; a new one
 * past that replaces the oldest. Push services answer 404/410 for a subscription that's gone,
 * and the sender deletes it then.
 */
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: appConstants.DEFAULT_REGION }));
const TABLE = DB_TABLE_NAME;

export const PUSH = "PUSH";
export const MAX_PUSH_SUBSCRIPTIONS = 10;

const userPk = (userId: string) => `${appConstants.DYNAMO_ENTITY_USER}#${userId}`;
export const pushSubscriptionId = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex").slice(0, 32);
const pushKey = (userId: string, endpoint: string) => ({ pk: userPk(userId), sk: `${PUSH}#${pushSubscriptionId(endpoint)}` });

export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: number;
}

export async function listPushSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
  const rows = await queryAllWithPrefix(userPk(userId), `${PUSH}#`, TABLE);
  return rows
    .map((r) => ({
      endpoint: String(r.endpoint),
      p256dh: String(r.p256dh),
      auth: String(r.auth),
      createdAt: Number(r.createdAt ?? 0),
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Saves (or refreshes) a browser's subscription; past the cap, the oldest others go. */
export async function savePushSubscription(
  userId: string,
  sub: { endpoint: string; p256dh: string; auth: string },
  now = Date.now()
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...pushKey(userId, sub.endpoint), ...sub, createdAt: now },
    })
  );
  const all = await listPushSubscriptions(userId);
  const extra = all.filter((s) => s.endpoint !== sub.endpoint).slice(0, Math.max(0, all.length - MAX_PUSH_SUBSCRIPTIONS));
  await Promise.all(extra.map((s) => deletePushSubscription(userId, s.endpoint)));
}

export async function deletePushSubscription(userId: string, endpoint: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: pushKey(userId, endpoint) }));
}
