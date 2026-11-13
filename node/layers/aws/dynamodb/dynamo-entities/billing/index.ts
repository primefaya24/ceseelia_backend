import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  TransactWriteCommandInput,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../../constants";
import { DB_TABLE_NAME } from "../../../../../config";
import {
  normalizeAdminSettings,
  normalizeStoreLifecycle,
  StoreBillingCheckout,
  StoreLifecycle,
  StoreSubscription,
} from "../../../../core/interfaces/store";
import { transactionFailedAt } from "../slug";

/*
 * Stripe Billing records (progress.md P.5):
 *   STORE#<id> / SETTINGS   own attributes `subscription` and `billingCheckout` (with `lifecycle`)
 *   USER#<id> / BILLING#<CURRENCY>   { stripeCustomerId }: one Stripe Customer per account and
 *       currency (a Stripe customer can only hold subscriptions in one currency)
 *   APP_BILLING_GRACE / STORE#<id>   { storeId, graceEndsAt }: stores in payment grace, so the
 *       hourly sweep finds them with one query (no scan, no new index)
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: appConstants.DEFAULT_REGION }));
const TABLE = DB_TABLE_NAME;
const settingsKey = (storeId: string) => ({ pk: `STORE#${storeId}`, sk: appConstants.DYNAMO_ENTITY_SETTINGS });
const customerKey = (userId: string, currency: string) => ({ pk: `USER#${userId}`, sk: `BILLING#${currency.toUpperCase()}` });
const GRACE_PK = "APP_BILLING_GRACE";
const graceKey = (storeId: string) => ({ pk: GRACE_PK, sk: `STORE#${storeId}` });

/** Someone else changed the store's lifecycle or subscription between our read and write. */
export class BillingWriteConflictError extends Error {
  constructor() {
    super("The store's billing changed meanwhile");
    this.name = "BillingWriteConflictError";
  }
}

export interface StoreBillingState {
  storeId: string;
  /** The saved lifecycle was missing (a store from before P.2, read as LIVE on FREE). */
  lifecycleMissing: boolean;
  lifecycle: StoreLifecycle;
  suspended: boolean;
  storeName: string;
  subscription?: StoreSubscription;
  checkout?: StoreBillingCheckout;
}

/** The store's billing view, or null when the store doesn't exist. */
export async function getStoreBillingState(storeId: string): Promise<StoreBillingState | null> {
  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: settingsKey(storeId),
      ProjectionExpression: "#pk, #lc, #sub, #co, #admin, #info.#name",
      ExpressionAttributeNames: {
        "#pk": "pk",
        "#lc": "lifecycle",
        "#sub": "subscription",
        "#co": "billingCheckout",
        "#admin": "admin",
        "#info": "storeInfo",
        "#name": "storeName",
      },
    })
  );
  const item = res.Item;
  if (!item) return null;
  return {
    storeId,
    lifecycleMissing: item.lifecycle === undefined,
    lifecycle: normalizeStoreLifecycle(item.lifecycle),
    suspended: normalizeAdminSettings(item.admin).suspended,
    storeName: typeof item.storeInfo?.storeName === "string" ? item.storeInfo.storeName : "",
    ...(item.subscription ? { subscription: item.subscription as StoreSubscription } : {}),
    ...(item.billingCheckout ? { checkout: item.billingCheckout as StoreBillingCheckout } : {}),
  };
}

/*
 * Save what the sync worked out, only if the lifecycle and subscription are still what it read
 * (BillingWriteConflictError otherwise: read again and retry). `lifecycle` null = unchanged.
 * `grace`: "PUT" lists the store for the sweep, "DELETE" takes it off, null leaves it.
 */
export async function writeStoreBilling(
  read: StoreBillingState,
  change: {
    subscription: StoreSubscription;
    lifecycle: StoreLifecycle | null;
    clearCheckout: boolean;
    grace: "PUT" | "DELETE" | null;
  }
): Promise<void> {
  const names: Record<string, string> = { "#sub": "subscription", "#lc": "lifecycle" };
  const values: Record<string, unknown> = { ":sub": change.subscription };
  const sets = ["#sub = :sub"];
  const removes: string[] = [];
  const conditions = ["attribute_exists(pk)"];

  if (read.lifecycleMissing) {
    conditions.push("attribute_not_exists(#lc)");
  } else {
    names["#st"] = "status";
    names["#pl"] = "plan";
    values[":st"] = read.lifecycle.status;
    values[":pl"] = read.lifecycle.plan;
    conditions.push("#lc.#st = :st AND #lc.#pl = :pl");
  }
  if (read.subscription) {
    names["#sid"] = "subscriptionId";
    values[":sid"] = read.subscription.subscriptionId;
    conditions.push("#sub.#sid = :sid");
  } else {
    conditions.push("attribute_not_exists(#sub)");
  }
  if (change.lifecycle) {
    values[":lc"] = change.lifecycle;
    sets.push("#lc = :lc");
  }
  if (change.clearCheckout) {
    names["#co"] = "billingCheckout";
    removes.push("#co");
  }

  const items: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
    {
      Update: {
        TableName: TABLE,
        Key: settingsKey(read.storeId),
        UpdateExpression: `SET ${sets.join(", ")}${removes.length ? ` REMOVE ${removes.join(", ")}` : ""}`,
        ConditionExpression: conditions.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    },
  ];
  if (change.grace === "PUT" && change.subscription.graceEndsAt !== null) {
    items.push({
      Put: {
        TableName: TABLE,
        Item: { ...graceKey(read.storeId), storeId: read.storeId, graceEndsAt: change.subscription.graceEndsAt },
      },
    });
  } else if (change.grace === "DELETE") {
    items.push({ Delete: { TableName: TABLE, Key: graceKey(read.storeId) } });
  }
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (e) {
    if (transactionFailedAt(e, 0)) throw new BillingWriteConflictError();
    throw e;
  }
}

/** Remember the open checkout (P.5), so a second click reuses it. */
export async function saveBillingCheckout(storeId: string, checkout: StoreBillingCheckout): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: settingsKey(storeId),
      UpdateExpression: "SET #co = :co",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#co": "billingCheckout" },
      ExpressionAttributeValues: { ":co": checkout },
    })
  );
}

/** Forget the open checkout if it's still this one (it expired, or it finished). */
export async function clearBillingCheckout(storeId: string, sessionId: string): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: settingsKey(storeId),
        UpdateExpression: "REMOVE #co",
        ConditionExpression: "#co.#sid = :sid",
        ExpressionAttributeNames: { "#co": "billingCheckout", "#sid": "sessionId" },
        ExpressionAttributeValues: { ":sid": sessionId },
      })
    );
  } catch (e) {
    if ((e as { name?: string })?.name !== "ConditionalCheckFailedException") throw e;
  }
}

/** The account's Stripe Customer for this currency, or null. */
export async function getBillingCustomerId(userId: string, currency: string): Promise<string | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: customerKey(userId, currency) }));
  return typeof res.Item?.stripeCustomerId === "string" ? res.Item.stripeCustomerId : null;
}

/* Save a new customer unless one was saved first (two clicks at once); returns the one kept. */
export async function saveBillingCustomerId(userId: string, currency: string, customerId: string): Promise<string> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { ...customerKey(userId, currency), stripeCustomerId: customerId, createdAt: Date.now() },
        ConditionExpression: "attribute_not_exists(pk)",
      })
    );
    return customerId;
  } catch (e) {
    if ((e as { name?: string })?.name !== "ConditionalCheckFailedException") throw e;
    return (await getBillingCustomerId(userId, currency)) ?? customerId;
  }
}

/** Stores whose payment grace has ended by `now`. */
export async function listExpiredGrace(now: number): Promise<string[]> {
  const out: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk",
        FilterExpression: "graceEndsAt <= :now",
        ExpressionAttributeValues: { ":pk": GRACE_PK, ":now": now },
        ExclusiveStartKey: start,
      })
    );
    for (const row of res.Items ?? []) if (typeof row.storeId === "string") out.push(row.storeId);
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}

/** Take a store off the grace list (its subscription no longer exists). */
export async function deleteGraceEntry(storeId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: graceKey(storeId) }));
}
