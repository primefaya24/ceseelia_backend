// Store membership (progress.md 1.2): which users can work on which store, and in what role.
//
// Two rows per membership, always written and deleted together in one transaction:
//   STORE#<storeId> / MEMBER#<userId>   { storeMemberId, storeMemberPermission, created/updated }
//   USER#<userId>   / STORE#<storeId>   { storeId, storeMemberPermission, created }
// The first lists a store's members, the second a user's stores. Neither copies names, emails or
// store names/slugs: those are read from the user's PROFILE#INFO and the store's OVERVIEW row, so
// a rename never leaves stale copies behind.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../../constants";
import { DB_TABLE_NAME } from "../../../../../config";
import { dynamGetManyItems } from "../../dynamo-batch-ops";
import { queryAllWithPrefix } from "../../dynamo-query";

const dynamoDbDocumentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: appConstants.DEFAULT_REGION })
);
const TABLE = DB_TABLE_NAME;

export type StoreRole = "ADMIN" | "MERCHANT";
export const STORE_ROLES: StoreRole[] = [
  appConstants.STORE_MEMBER_PERMISSION_ADMIN as StoreRole,
  appConstants.STORE_MEMBER_PERMISSION_MERCHANT as StoreRole,
];

export interface Membership {
  storeId: string;
  userId: string;
  role: StoreRole;
  createdAt: number;
}

/* A user's store, as get-my-profile returns it. */
export interface UserStore {
  storeId: string;
  storeName: string;
  storeSlug: string;
  role: StoreRole;
}

/* A store's member, with name and email from their profile. */
export interface StoreMemberView {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  role: StoreRole;
  createdAt: number;
}

export class MembershipError extends Error {
  constructor(
    readonly reason: "STORE_NOT_FOUND" | "USER_NOT_FOUND" | "ALREADY_MEMBER" | "NOT_A_MEMBER",
    message: string
  ) {
    super(message);
    this.name = "MembershipError";
  }
}

const storePk = (storeId: string) => `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}`;
const userPk = (userId: string) => `${appConstants.DYNAMO_ENTITY_USER}#${userId}`;
const memberSk = (userId: string) => `${appConstants.DYNAMO_ENTITY_MEMBER}#${userId}`;
const userStoreSk = (storeId: string) => `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}`;
const profileInfoKey = (userId: string) => ({
  pk: userPk(userId),
  sk: `${appConstants.DYNAMO_ENTITY_PROFILE}#${appConstants.DYNAMO_ENTITY_INFO}`,
});
const storeOverviewKey = (storeId: string) => ({
  pk: appConstants.DYNAMO_ENTITY_APP_STORE,
  sk: `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}#${appConstants.DYNAMO_ENTITY_OVERVIEW}`,
});

/* Index of the transaction item whose condition failed, or -1. */
function failedConditionIndex(e: unknown): number {
  const err = e as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  if (err?.name !== "TransactionCanceledException") return -1;
  return (err.CancellationReasons ?? []).findIndex((r) => r?.Code === "ConditionalCheckFailed");
}

/*
 * Make a user a member of a store. Both the store (SETTINGS row) and the user (PROFILE#INFO) must
 * exist. Throws MembershipError if either is missing or the user is already a member.
 */
export async function addStoreMember(storeId: string, userId: string, role: StoreRole): Promise<Membership> {
  if (!STORE_ROLES.includes(role)) {
    throw new Error(`Unknown store role: ${role}`);
  }
  const now = Date.now();
  try {
    await dynamoDbDocumentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: TABLE,
              Key: { pk: storePk(storeId), sk: appConstants.DYNAMO_ENTITY_SETTINGS },
              ConditionExpression: "attribute_exists(pk)",
            },
          },
          {
            ConditionCheck: {
              TableName: TABLE,
              Key: profileInfoKey(userId),
              ConditionExpression: "attribute_exists(pk)",
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: {
                pk: storePk(storeId),
                sk: memberSk(userId),
                storeMemberId: userId,
                storeMemberPermission: role,
                storeMemberCreatedAt: now,
                storeMemberUpdatedAt: now,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: {
                pk: userPk(userId),
                sk: userStoreSk(storeId),
                storeId,
                storeMemberPermission: role,
                storeMemberCreatedAt: now,
              },
            },
          },
        ],
      })
    );
  } catch (e) {
    switch (failedConditionIndex(e)) {
      case 0:
        throw new MembershipError("STORE_NOT_FOUND", "Store not found");
      case 1:
        throw new MembershipError("USER_NOT_FOUND", "User not found");
      case 2:
        throw new MembershipError("ALREADY_MEMBER", "User is already a member of this store");
      default:
        throw e;
    }
  }
  return { storeId, userId, role, createdAt: now };
}

/* Remove both membership rows. Throws MembershipError NOT_A_MEMBER if there was none. */
export async function removeStoreMember(storeId: string, userId: string): Promise<void> {
  try {
    await dynamoDbDocumentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: TABLE,
              Key: { pk: storePk(storeId), sk: memberSk(userId) },
              ConditionExpression: "attribute_exists(pk)",
            },
          },
          { Delete: { TableName: TABLE, Key: { pk: userPk(userId), sk: userStoreSk(storeId) } } },
        ],
      })
    );
  } catch (e) {
    if (failedConditionIndex(e) === 0) {
      throw new MembershipError("NOT_A_MEMBER", "User is not a member of this store");
    }
    throw e;
  }
}

/* The user's membership of a store, or null. Strongly consistent: used for access checks (1.3). */
export async function getMembership(storeId: string, userId: string): Promise<Membership | null> {
  const res = await dynamoDbDocumentClient.send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: storePk(storeId), sk: memberSk(userId) },
      ConsistentRead: true,
    })
  );
  if (!res.Item) return null;
  return {
    storeId,
    userId,
    role: res.Item.storeMemberPermission,
    createdAt: res.Item.storeMemberCreatedAt,
  };
}

/* A store's members with their current name and email, oldest first. */
export async function listStoreMembers(storeId: string): Promise<StoreMemberView[]> {
  const rows = await queryAllWithPrefix(storePk(storeId), `${appConstants.DYNAMO_ENTITY_MEMBER}#`, TABLE);
  if (rows.length === 0) return [];
  const profiles = await dynamGetManyItems(TABLE, rows.map((r) => profileInfoKey(r.storeMemberId)));
  const byPk = new Map(profiles.map((p) => [p.pk as string, p]));
  return rows
    .map((r) => {
      const p: Record<string, any> = byPk.get(userPk(r.storeMemberId)) ?? {};
      return {
        userId: r.storeMemberId,
        firstName: p.userFirstName ?? "",
        lastName: p.userLastName ?? "",
        email: p.userEmailAddress ?? "",
        role: r.storeMemberPermission,
        createdAt: r.storeMemberCreatedAt,
      };
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

/*
 * The stores a user belongs to, with their current name and slug, sorted by name.
 * A membership whose store overview is gone (store deleted) is left out.
 */
export async function listUserStores(userId: string): Promise<UserStore[]> {
  const rows = await queryAllWithPrefix(userPk(userId), `${appConstants.DYNAMO_ENTITY_STORE}#`, TABLE);
  if (rows.length === 0) return [];
  const overviews = await dynamGetManyItems(TABLE, rows.map((r) => storeOverviewKey(r.storeId)));
  const bySk = new Map(overviews.map((o) => [o.sk as string, o]));
  const stores: UserStore[] = [];
  for (const r of rows) {
    const o = bySk.get(storeOverviewKey(r.storeId).sk);
    if (o) {
      stores.push({
        storeId: r.storeId,
        storeName: (o.storeName as string) ?? "",
        storeSlug: (o.storeSlug as string) ?? "",
        role: r.storeMemberPermission,
      });
    }
  }
  return stores.sort((a, b) => a.storeName.localeCompare(b.storeName));
}
