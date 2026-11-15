import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../../constants";
import { DB_TABLE_NAME } from "../../../../../config";
import { StoreOrder } from "../../../../core/interfaces/store";
import { pointsFor } from "../../../../core/rewards";
import { customerIdFor } from "../customer";

/*
 * Purchase rewards data (progress.md L.7 / 7.4). All under the store's partition:
 *   REWARDS#<customerId>            { email, balance, earned, redeemed, updatedAt } (customerId as
 *                                   for Customers: sha256 of the email)
 *   REWARDS_EARN#<orderId>          { customerId, points, rate } points this order has given
 *   REWARDS_CODE#<customerId>       { hash, salt, expiresAt, attempts, ttl } one live code
 *   REWARDS_SESSION#<sha256(token)> { customerId, email, expiresAt, ttl }
 *   REWARDS_LIMIT#<customerId>#<kind>#<window> { count, ttl } per-email limits that outlive a
 *                                   restart (the IP limits are in memory)
 *
 * Security (owner 2026-11-15: "someone can't try all combinations of a 6-digit number"):
 *   - Codes: 6 digits from crypto, kept only as a salted hash, 10 minutes, single use, and at
 *     most CODE_MAX_ATTEMPTS guesses: each guess is counted by a conditional update *before* the
 *     comparison, so parallel requests can't get more. A new code replaces the old one, and codes
 *     are capped per email (3 / 15 min, 10 / day) and per IP: at most ~50 guesses a day per email
 *     out of 1,000,000.
 *   - Sessions: 32 random bytes, kept hashed, 30 days, per store.
 *   - Points only come from paid orders (`recordRewardsForOrder`, idempotent per order) and are
 *     spent inside create-order's own transaction, conditional on the balance.
 */
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: appConstants.DEFAULT_REGION }));
const TABLE = DB_TABLE_NAME;

export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const CODE_LIMITS = [
  { kind: "code15m", windowMs: 15 * 60_000, max: 3 },
  { kind: "codeDay", windowMs: 24 * 3600_000, max: 10 },
] as const;

const storePk = (storeId: string) => `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}`;
const accountKey = (storeId: string, customerId: string) => ({ pk: storePk(storeId), sk: `REWARDS#${customerId}` });
const earnKey = (storeId: string, orderId: string) => ({ pk: storePk(storeId), sk: `REWARDS_EARN#${orderId}` });
const codeKey = (storeId: string, customerId: string) => ({ pk: storePk(storeId), sk: `REWARDS_CODE#${customerId}` });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sessionKey = (storeId: string, token: string) => ({ pk: storePk(storeId), sk: `REWARDS_SESSION#${sha(token)}` });
const ttlOf = (ms: number) => Math.ceil(ms / 1000);
const isCondFail = (e: unknown) => (e as { name?: string })?.name === "ConditionalCheckFailedException";

export const normEmail = (email: string) => email.trim().toLowerCase();

export interface RewardsAccount {
  customerId: string;
  email: string;
  balance: number;
  earned: number;
  redeemed: number;
}

export async function getRewardsAccount(storeId: string, customerId: string): Promise<RewardsAccount | null> {
  const row = (await ddb.send(new GetCommand({ TableName: TABLE, Key: accountKey(storeId, customerId), ConsistentRead: true }))).Item;
  if (!row) return null;
  return {
    customerId,
    email: String(row.email ?? ""),
    balance: Number(row.balance ?? 0),
    earned: Number(row.earned ?? 0),
    redeemed: Number(row.redeemed ?? 0),
  };
}

/* ---------------- Limits that outlive a restart ---------------- */

/** Counts one use in each window; false (nothing counted past the cap) if any is full. */
export async function takeEmailLimit(
  storeId: string,
  customerId: string,
  limits: readonly { kind: string; windowMs: number; max: number }[],
  now: number
): Promise<boolean> {
  for (const l of limits) {
    const win = Math.floor(now / l.windowMs);
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { pk: storePk(storeId), sk: `REWARDS_LIMIT#${customerId}#${l.kind}#${win}` },
          UpdateExpression: "ADD #c :one SET #ttl = :ttl",
          ConditionExpression: "attribute_not_exists(#c) OR #c < :max",
          ExpressionAttributeNames: { "#c": "count", "#ttl": "ttl" },
          ExpressionAttributeValues: { ":one": 1, ":max": l.max, ":ttl": ttlOf((win + 1) * l.windowMs) + 3600 },
        })
      );
    } catch (e) {
      if (isCondFail(e)) return false;
      throw e;
    }
  }
  return true;
}

/* ---------------- Codes ---------------- */

/** A new 6-digit code for this email (replacing any earlier one). Returns the code to email. */
export async function issueCode(storeId: string, customerId: string, now: number): Promise<string> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const salt = randomBytes(16).toString("hex");
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...codeKey(storeId, customerId),
        hash: sha(`${salt}:${code}`),
        salt,
        attempts: 0,
        expiresAt: now + CODE_TTL_MS,
        ttl: ttlOf(now + CODE_TTL_MS) + 3600,
      },
    })
  );
  return code;
}

export type CheckCodeResult = "OK" | "WRONG" | "NO_CODE";

/**
 * One guess. The attempt is counted first (conditional: a live code with guesses left); only
 * then is the code compared, in constant time. Right: the code is deleted (single use).
 */
export async function checkCode(storeId: string, customerId: string, code: string, now: number): Promise<CheckCodeResult> {
  if (!/^\d{6}$/.test(code)) return "WRONG";
  let row: Record<string, unknown> | undefined;
  try {
    row = (
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: codeKey(storeId, customerId),
          UpdateExpression: "ADD attempts :one",
          ConditionExpression: "attribute_exists(pk) AND attempts < :max AND expiresAt > :now",
          ExpressionAttributeValues: { ":one": 1, ":max": CODE_MAX_ATTEMPTS, ":now": now },
          ReturnValues: "ALL_NEW",
        })
      )
    ).Attributes;
  } catch (e) {
    if (isCondFail(e)) return "NO_CODE";
    throw e;
  }
  const want = Buffer.from(String(row?.hash ?? ""), "hex");
  const got = Buffer.from(sha(`${String(row?.salt ?? "")}:${code}`), "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return "WRONG";
  try {
    await ddb.send(
      new DeleteCommand({ TableName: TABLE, Key: codeKey(storeId, customerId), ConditionExpression: "#h = :h", ExpressionAttributeNames: { "#h": "hash" }, ExpressionAttributeValues: { ":h": row!.hash } })
    );
  } catch (e) {
    // Used by a parallel right guess, or replaced: this one doesn't count.
    if (isCondFail(e)) return "NO_CODE";
    throw e;
  }
  return "OK";
}

/* ---------------- Sessions ---------------- */

export async function createSession(storeId: string, email: string, now: number): Promise<{ token: string; expiresAt: number }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + SESSION_TTL_MS;
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...sessionKey(storeId, token), customerId: customerIdFor(email), email: normEmail(email), expiresAt, ttl: ttlOf(expiresAt) },
    })
  );
  return { token, expiresAt };
}

export async function getSession(storeId: string, token: string, now: number): Promise<{ customerId: string; email: string } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = (await ddb.send(new GetCommand({ TableName: TABLE, Key: sessionKey(storeId, token) }))).Item;
  if (!row || Number(row.expiresAt) <= now) return null;
  return { customerId: String(row.customerId), email: String(row.email) };
}

export async function deleteSession(storeId: string, token: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: sessionKey(storeId, token) }));
}

/* ---------------- Spending (inside create-order's transaction) ---------------- */

/** The order's spend: take `points` from the account, only if the balance covers them. */
export function spendInTransaction(storeId: string, customerId: string, points: number, now: number) {
  return {
    Update: {
      TableName: TABLE,
      Key: accountKey(storeId, customerId),
      UpdateExpression: "ADD balance :minus, redeemed :points SET updatedAt = :now",
      ConditionExpression: "balance >= :points",
      ExpressionAttributeValues: { ":minus": -points, ":points": points, ":now": now },
    },
  };
}

/** Give the order's spent points back (it was never paid, or fully refunded). */
export function refundSpendInTransaction(storeId: string, customerId: string, points: number, now: number) {
  return {
    Update: {
      TableName: TABLE,
      Key: accountKey(storeId, customerId),
      UpdateExpression: "ADD balance :points, redeemed :minus SET updatedAt = :now",
      ExpressionAttributeValues: { ":points": points, ":minus": -points, ":now": now },
    },
  };
}

/* ---------------- Earning ---------------- */

/** The items the shopper paid for (after all discounts, before delivery and tax), less refunds' share. */
export function earnBaseMinor(order: StoreOrder): number {
  const items = Math.max(0, order.storeOrderSubtotalMinor - order.storeOrderDiscountMinor - (order.storeOrderRewards?.rewardsMinor ?? 0));
  const total = order.storeOrderTotalMinor;
  if (!(total > 0)) return 0;
  const kept = Math.max(0, total - (order.storeOrderRefundedMinor ?? 0)) / total;
  return Math.floor(items * kept);
}

const earnable = (o: StoreOrder) =>
  typeof o.storeOrderPaidAt === "number" && o.storeOrderStatus !== "PENDING_PAYMENT" && o.storeOrderStatus !== "CANCELLED";

export type EarnResult = "ADDED" | "UPDATED" | "UNCHANGED" | "SKIPPED";

/**
 * The order's points, idempotent (like the customer record): the first call on a paid order
 * gives the points at `rate` (the store's rate when it was paid; null = no program then, nothing
 * happens), later calls (refunds) move the balance by the difference only.
 */
export async function recordRewardsForOrder(order: StoreOrder, rate: number | null, now: number): Promise<EarnResult> {
  const email = normEmail(order.storeOrderCustomer?.email ?? "");
  if (!email || !earnable(order)) return "SKIPPED";
  const customerId = customerIdFor(email);
  const pk = storePk(order.storeId);
  for (let i = 0; ; i++) {
    const marker = (await ddb.send(new GetCommand({ TableName: TABLE, Key: earnKey(order.storeId, order.storeOrderId), ConsistentRead: true }))).Item;
    try {
      if (!marker) {
        if (!rate || !(rate > 0)) return "SKIPPED";
        const points = pointsFor(earnBaseMinor(order), rate);
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: { TableName: TABLE, Item: { ...earnKey(order.storeId, order.storeOrderId), customerId, points, rate, at: now }, ConditionExpression: "attribute_not_exists(pk)" } },
              {
                Update: {
                  TableName: TABLE,
                  Key: { pk, sk: `REWARDS#${customerId}` },
                  UpdateExpression: "ADD balance :p, earned :p SET email = :email, updatedAt = :now",
                  ExpressionAttributeValues: { ":p": points, ":email": email, ":now": now },
                },
              },
            ],
          })
        );
        return "ADDED";
      }
      const before = Number(marker.points ?? 0);
      const target = pointsFor(earnBaseMinor(order), Number(marker.rate ?? 0));
      if (target === before) return "UNCHANGED";
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: TABLE,
                Key: earnKey(order.storeId, order.storeOrderId),
                UpdateExpression: "SET points = :now",
                ConditionExpression: "points = :before",
                ExpressionAttributeValues: { ":now": target, ":before": before },
              },
            },
            {
              Update: {
                TableName: TABLE,
                Key: { pk, sk: `REWARDS#${String(marker.customerId)}` },
                // A refund after the points were spent can take the balance below 0: it can't be
                // spent until new orders bring it back (buy, earn, spend, refund doesn't pay).
                UpdateExpression: "ADD balance :d, earned :d SET updatedAt = :t",
                ExpressionAttributeValues: { ":d": target - before, ":t": now },
              },
            },
          ],
        })
      );
      return "UPDATED";
    } catch (e) {
      if ((e as { name?: string }).name !== "TransactionCanceledException" || i >= 2) throw e;
    }
  }
}
