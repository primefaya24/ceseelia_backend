// Store membership (progress.md 1.2): which users can work on which store, and in what role.
//
// Two rows per membership, always written and deleted together in one transaction:
//   STORE#<storeId> / MEMBER#<userId>   { storeMemberId, storeMemberPermission, created/updated }
//   USER#<userId>   / STORE#<storeId>   { storeId, storeMemberPermission, created }
// The first lists a store's members, the second a user's stores. Neither copies names, emails or
// store names/slugs: those are read from the user's PROFILE#INFO and the store's OVERVIEW row, so
// a rename never leaves stale copies behind.
//
// Pending invites (progress.md 1.4) for an email with no account yet, also two rows:
//   STORE#<storeId>  / INVITE#<email>   { storeInviteEmail, storeMemberPermission, created }
//   INVITE#<email>   / STORE#<storeId>  { storeId, storeMemberPermission, created }
// The first lists a store's invites, the second finds them when that email signs up.
// claimStoreInvites turns them into memberships on the user's first get-my-profile.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
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

/* A pending invite, as get-store-members returns it. */
export interface StoreInvite {
  email: string;
  role: StoreRole;
  createdAt: number;
}

export class MembershipError extends Error {
  constructor(
    readonly reason: "STORE_NOT_FOUND" | "USER_NOT_FOUND" | "ALREADY_MEMBER" | "NOT_A_MEMBER" | "NOT_INVITED",
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
const invitePk = (email: string) => `${appConstants.DYNAMO_ENTITY_INVITE}#${email}`;
const inviteSk = (email: string) => `${appConstants.DYNAMO_ENTITY_INVITE}#${email}`;
const settingsKey = (storeId: string) => ({ pk: storePk(storeId), sk: appConstants.DYNAMO_ENTITY_SETTINGS });

/* Emails are stored and matched lower-case and trimmed. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

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

/* The store's overview row (name, slug, …), or null if there's no such store. */
export async function getStoreOverviewRow(storeId: string): Promise<Record<string, any> | null> {
  const res = await dynamoDbDocumentClient.send(new GetCommand({ TableName: TABLE, Key: storeOverviewKey(storeId) }));
  return res.Item ?? null;
}

////////////////////////////////////////
// Invites (progress.md 1.4)
////////////////////////////////////////

/*
 * Invite an email that has no account yet. Inviting the same email to the same store again
 * replaces the invite (new role, new date), so an admin can simply resend it.
 * Throws MembershipError STORE_NOT_FOUND if the store doesn't exist.
 */
export async function inviteStoreMember(storeId: string, rawEmail: string, role: StoreRole): Promise<StoreInvite> {
  if (!STORE_ROLES.includes(role)) {
    throw new Error(`Unknown store role: ${role}`);
  }
  const email = normalizeEmail(rawEmail);
  const now = Date.now();
  try {
    await dynamoDbDocumentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          { ConditionCheck: { TableName: TABLE, Key: settingsKey(storeId), ConditionExpression: "attribute_exists(pk)" } },
          {
            Put: {
              TableName: TABLE,
              Item: {
                pk: storePk(storeId),
                sk: inviteSk(email),
                storeInviteEmail: email,
                storeMemberPermission: role,
                storeInviteCreatedAt: now,
              },
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: {
                pk: invitePk(email),
                sk: userStoreSk(storeId),
                storeId,
                storeMemberPermission: role,
                storeInviteCreatedAt: now,
              },
            },
          },
        ],
      })
    );
  } catch (e) {
    if (failedConditionIndex(e) === 0) {
      throw new MembershipError("STORE_NOT_FOUND", "Store not found");
    }
    throw e;
  }
  return { email, role, createdAt: now };
}

/* Delete both invite rows. Throws MembershipError NOT_INVITED if there was no invite. */
export async function cancelStoreInvite(storeId: string, rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  try {
    await dynamoDbDocumentClient.send(
      new TransactWriteCommand({
        TransactItems: inviteDeletes(storeId, email, true),
      })
    );
  } catch (e) {
    if (failedConditionIndex(e) === 0) {
      throw new MembershipError("NOT_INVITED", "No pending invite for this email");
    }
    throw e;
  }
}

function inviteDeletes(storeId: string, email: string, mustExist: boolean) {
  return [
    {
      Delete: {
        TableName: TABLE,
        Key: { pk: storePk(storeId), sk: inviteSk(email) },
        ...(mustExist ? { ConditionExpression: "attribute_exists(pk)" } : {}),
      },
    },
    { Delete: { TableName: TABLE, Key: { pk: invitePk(email), sk: userStoreSk(storeId) } } },
  ];
}

/* A store's pending invites, oldest first. */
export async function listStoreInvites(storeId: string): Promise<StoreInvite[]> {
  const rows = await queryAllWithPrefix(storePk(storeId), `${appConstants.DYNAMO_ENTITY_INVITE}#`, TABLE);
  return rows
    .map((r) => ({ email: r.storeInviteEmail, role: r.storeMemberPermission, createdAt: r.storeInviteCreatedAt }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/*
 * Turn every pending invite for `email` into a membership of `userId` (called from get-my-profile;
 * the email must be the user's verified one, from their profile, never from a request).
 * Each invite is claimed in its own transaction: invite rows deleted and membership rows written
 * together. An invite to a store that's gone, or one the user already belongs to, is just
 * removed. Returns the store IDs joined.
 */
export async function claimStoreInvites(userId: string, rawEmail: string): Promise<string[]> {
  const email = normalizeEmail(rawEmail ?? "");
  if (!email) return [];
  const res = await dynamoDbDocumentClient.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: { ":pk": invitePk(email) },
    })
  );
  const joined: string[] = [];
  for (const invite of res.Items ?? []) {
    const storeId: string = invite.storeId;
    const role: StoreRole = invite.storeMemberPermission;
    const now = Date.now();
    try {
      await dynamoDbDocumentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            { ConditionCheck: { TableName: TABLE, Key: settingsKey(storeId), ConditionExpression: "attribute_exists(pk)" } },
            ...inviteDeletes(storeId, email, true),
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
                Item: { pk: userPk(userId), sk: userStoreSk(storeId), storeId, storeMemberPermission: role, storeMemberCreatedAt: now },
              },
            },
          ],
        })
      );
      joined.push(storeId);
    } catch (e) {
      const failed = failedConditionIndex(e);
      if (failed === 0 || failed === 3) {
        // Store deleted, or already a member: the invite has nothing left to do
        await dynamoDbDocumentClient.send(new TransactWriteCommand({ TransactItems: inviteDeletes(storeId, email, false) }));
      } else if (failed !== 1) {
        // 1 = claimed by a parallel request already; anything else is a real error
        throw e;
      }
    }
  }
  return joined;
}
