import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../../constants";
import { DB_TABLE_NAME } from "../../../../../config";
import { dynamGetManyItems } from "../../dynamo-batch-ops";
import {
  normalizeAdminSettings,
  normalizeStoreLifecycle,
  StoreLifecycle,
  StoreReview,
  StoreSubscription,
} from "../../../../core/interfaces/store";
import { StoreStatusChangedError, reviewQueueKey } from "../store";
import { transactionFailedAt } from "../slug";
import { toStorePlanOrNone } from "../../../../core/plans";

/*
 * Platform admin views and actions on stores (progress.md P.8): the status / plan / billing
 * summary for Admin › Stores, the review queue (`APP_REVIEW / STORE#<id>`, written by Go Live
 * with IN_REVIEW), review decisions and setting a plan by hand. Every write is conditional on
 * the lifecycle the admin's request was checked against.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: appConstants.DEFAULT_REGION }));
const TABLE = DB_TABLE_NAME;
const settingsKey = (storeId: string) => ({ pk: `STORE#${storeId}`, sk: appConstants.DYNAMO_ENTITY_SETTINGS });
const overviewKey = (storeId: string) => ({
  pk: appConstants.DYNAMO_ENTITY_APP_STORE,
  sk: `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}#${appConstants.DYNAMO_ENTITY_OVERVIEW}`,
});
const storeIdOfPk = (pk: unknown) => String(pk).slice("STORE#".length);

/** A store's state as Admin › Stores lists it. No Stripe ids. */
export interface AdminStoreSummary {
  status: StoreLifecycle["status"];
  plan: StoreLifecycle["plan"];
  suspended: boolean;
  planSetByAdmin: boolean;
  subscription: {
    plan: StoreSubscription["plan"];
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: number | null;
    graceEndsAt: number | null;
  } | null;
}

export function summarize(row: Record<string, unknown> | undefined): AdminStoreSummary {
  const lc = normalizeStoreLifecycle(row?.lifecycle);
  const sub = row?.subscription as StoreSubscription | undefined;
  return {
    status: lc.status,
    plan: lc.plan,
    suspended: normalizeAdminSettings(row?.admin).suspended,
    planSetByAdmin: lc.planSetByAdmin === true,
    subscription: sub
      ? {
          plan: sub.plan,
          status: sub.status,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd === true,
          currentPeriodEnd: sub.currentPeriodEnd ?? null,
          graceEndsAt: sub.graceEndsAt ?? null,
        }
      : null,
  };
}

/* Summaries for these stores, by store id (stores without a SETTINGS row are left out). */
export async function getStoreSummaries(storeIds: string[]): Promise<Record<string, AdminStoreSummary>> {
  if (storeIds.length === 0) return {};
  const rows = await dynamGetManyItems(TABLE, storeIds.map(settingsKey));
  const out: Record<string, AdminStoreSummary> = {};
  for (const row of rows) out[storeIdOfPk(row.pk)] = summarize(row);
  return out;
}

export interface ReviewQueueEntry {
  storeId: string;
  storeName: string;
  storeSlug: string;
  requestedAt: number;
  requestedPlan: string;
  reasons: string[];
  requestedByUserId: string | null;
}

/* Stores waiting for review, oldest first, with their name and link from the store list. */
export async function listReviewQueue(): Promise<ReviewQueueEntry[]> {
  const rows: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": reviewQueueKey("x").pk },
        ExclusiveStartKey: start,
      })
    );
    rows.push(...(res.Items ?? []));
    start = res.LastEvaluatedKey;
  } while (start);
  const ids = rows.map((r) => String(r.storeId)).filter(Boolean);
  const overviews = ids.length ? await dynamGetManyItems(TABLE, ids.map(overviewKey)) : [];
  const byId = new Map(overviews.map((o) => [String(o.storeId), o]));
  return rows
    .map((r) => {
      const o = byId.get(String(r.storeId));
      return {
        storeId: String(r.storeId),
        storeName: typeof o?.storeName === "string" ? o.storeName : "",
        storeSlug: typeof o?.storeSlug === "string" ? o.storeSlug : "",
        requestedAt: typeof r.requestedAt === "number" ? r.requestedAt : 0,
        requestedPlan: toStorePlanOrNone(r.requestedPlan),
        reasons: Array.isArray(r.reasons) ? r.reasons.map(String) : [],
        requestedByUserId: typeof r.requestedByUserId === "string" ? r.requestedByUserId : null,
      };
    })
    .sort((a, b) => a.requestedAt - b.requestedAt);
}

export interface StoreAdminState {
  storeId: string;
  lifecycleMissing: boolean;
  lifecycle: StoreLifecycle;
  review?: StoreReview;
  subscription?: StoreSubscription;
}

/** What a review decision or plan change is checked against, or null without the store. */
export async function getStoreAdminState(storeId: string): Promise<StoreAdminState | null> {
  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: settingsKey(storeId),
      ProjectionExpression: "#pk, #lc, #review, #sub",
      ExpressionAttributeNames: { "#pk": "pk", "#lc": "lifecycle", "#review": "review", "#sub": "subscription" },
    })
  );
  if (!res.Item) return null;
  return {
    storeId,
    lifecycleMissing: res.Item.lifecycle === undefined,
    lifecycle: normalizeStoreLifecycle(res.Item.lifecycle),
    ...(res.Item.review ? { review: res.Item.review as StoreReview } : {}),
    ...(res.Item.subscription ? { subscription: res.Item.subscription as StoreSubscription } : {}),
  };
}

/*
 * Save a review decision: the new lifecycle, the review answered (its attribute removed) and the
 * store off the queue, in one write, only while the store is still IN_REVIEW.
 * Throws StoreStatusChangedError otherwise.
 */
export async function saveReviewDecision(storeId: string, lifecycle: StoreLifecycle): Promise<void> {
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: settingsKey(storeId),
              UpdateExpression: "SET #lc = :lc REMOVE #review",
              ConditionExpression: "#lc.#st = :inReview",
              ExpressionAttributeNames: { "#lc": "lifecycle", "#st": "status", "#review": "review" },
              ExpressionAttributeValues: { ":lc": lifecycle, ":inReview": "IN_REVIEW" },
            },
          },
          { Delete: { TableName: TABLE, Key: reviewQueueKey(storeId) } },
        ],
      })
    );
  } catch (e) {
    if (transactionFailedAt(e, 0)) throw new StoreStatusChangedError();
    throw e;
  }
}

/*
 * Set the plan by hand, only if the lifecycle is still what the admin saw and the store still
 * has the subscription it had (none, or an ended one). Throws StoreStatusChangedError otherwise.
 */
export async function saveAdminPlan(read: StoreAdminState, lifecycle: StoreLifecycle): Promise<void> {
  const names: Record<string, string> = { "#lc": "lifecycle", "#sub": "subscription" };
  const values: Record<string, unknown> = { ":lc": lifecycle };
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
    names["#subst"] = "status";
    values[":sid"] = read.subscription.subscriptionId;
    values[":subst"] = read.subscription.status;
    conditions.push("#sub.#sid = :sid AND #sub.#subst = :subst");
  } else {
    conditions.push("attribute_not_exists(#sub)");
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: settingsKey(read.storeId),
        UpdateExpression: "SET #lc = :lc",
        ConditionExpression: conditions.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
  } catch (e) {
    if ((e as { name?: string })?.name === "ConditionalCheckFailedException") throw new StoreStatusChangedError();
    throw e;
  }
}
