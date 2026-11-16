import { randomBytes } from "crypto";
import * as ULID from "ulid";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../../constants";
import { DB_TABLE_NAME } from "../../../../../config";
import { dynamGetManyItems } from "../../dynamo-batch-ops";
import { hashStatusToken } from "../order";
import { cleanReviewText } from "../review";

/*
 * Store ↔ shopper messages (progress.md L.10). A conversation is either about an order (its id
 * IS the order's id, so an order has at most one) or an inquiry from the storefront's Contact us
 * (a new ULID). Every row lives in the store's partition, so deleting the store deletes them.
 *
 *   STORE#<storeId> / CONVO#<conversationId>                    the conversation (Conversation)
 *   STORE#<storeId> / CONVO_ACT#<13-digit lastAt>#<id>          { conversationId }: the inbox, newest activity first
 *   STORE#<storeId> / CONVO_UNREAD#<id>                         { conversationId, since }: unread by the store
 *   STORE#<storeId> / CONVO_MSG#<id>#<13-digit at>#<ulid>       one message (ConversationMessage)
 *   APP_CONVO_NOTIFY / <13-digit dueAt>#STORE#<storeId>#<id>    email the store if still unread then
 *   APP_CONVO_REPORT / STORE#<storeId>#CONVO#<id>               an open report (admin queue)
 *
 * The shopper proves who they are with a token: for an order, the order's own (checkout or order
 * email); for an inquiry, one of `customerTokenHashes` (the browser that sent it, and each email
 * link). Only hashes are stored.
 */
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: appConstants.DEFAULT_REGION }));
const TABLE = DB_TABLE_NAME;

export const NOTIFY_PK = "APP_CONVO_NOTIFY";
export const REPORT_PK = "APP_CONVO_REPORT";
/** Messages per page (the chat loads older ones on scroll). */
export const MESSAGE_PAGE = 30;
/** Conversations per inbox page. */
export const CONVERSATION_PAGE = 20;
/** Photos per message. */
export const MAX_MESSAGE_IMAGES = 4;
/** Message text (photos can go without text). */
export const MAX_MESSAGE_LENGTH = 2000;
/** How long a shopper's message waits unread before the store gets an email (Settings, default on). */
export const STORE_EMAIL_DELAY_MS = 30 * 60_000;
/** Tokens kept per inquiry (the browser's, then one per email link); older links stop working. */
const MAX_TOKENS = 20;

export type ConversationKind = "ORDER" | "INQUIRY";
export type MessageFrom = "CUSTOMER" | "STORE";
export type ConversationStatus = "OPEN" | "BLOCKED";
export const CONVO_REPORT_REASONS = ["ABUSIVE", "SPAM", "SCAM", "OTHER"] as const;
export type ConvoReportReason = (typeof CONVO_REPORT_REASONS)[number];

export interface ConversationReport {
  reason: ConvoReportReason;
  note: string;
  byUserId: string;
  at: number;
  /** Set when an admin decided (DISMISS keeps it open and it can't be reported again; BLOCK closes it). */
  decision?: "DISMISS" | "BLOCK";
  decidedAt?: number;
}

export interface Conversation {
  conversationId: string;
  storeId: string;
  kind: ConversationKind;
  orderId: string | null;
  orderCode: string | null;
  customerName: string;
  customerEmail: string;
  status: ConversationStatus;
  messageCount: number;
  lastAt: number;
  lastFrom: MessageFrom;
  /** The start of the newest message, for the inbox ("📷 Photo" when it had only photos). */
  preview: string;
  /** Shopper messages the store hasn't read / store messages the shopper hasn't read. */
  storeUnread: number;
  customerUnread: number;
  storeReadAt: number;
  customerReadAt: number;
  /** When the shopper was last emailed about a store reply (one email until they read it). */
  customerEmailedAt: number;
  createdAt: number;
  report: ConversationReport | null;
  /** Inquiries only. Never leaves the server. */
  customerTokenHashes?: string[];
  /** The CONVO_ACT row's sort key (moves with every message). */
  actSk: string;
}

export interface ConversationMessage {
  messageId: string;
  from: MessageFrom;
  /** The shopper's name, or the store's name for store messages. */
  authorName: string;
  body: string;
  /** S3 keys under store/<storeId>/messages/<conversationId>/. */
  images: string[];
  at: number;
  /** Store messages: the member who sent it (never shown to the shopper). */
  byUserId?: string;
  /** Server cursor for paging (the row's sort key). */
  cursor: string;
}

const storePk = (storeId: string) => `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}`;
const ts = (n: number) => String(Math.max(0, Math.floor(n))).padStart(13, "0");
export const convoKey = (storeId: string, id: string) => ({ pk: storePk(storeId), sk: `CONVO#${id}` });
const actSkOf = (at: number, id: string) => `CONVO_ACT#${ts(at)}#${id}`;
const unreadKey = (storeId: string, id: string) => ({ pk: storePk(storeId), sk: `CONVO_UNREAD#${id}` });
const msgPrefix = (id: string) => `CONVO_MSG#${id}#`;
const msgSk = (id: string, at: number, msgId: string) => `${msgPrefix(id)}${ts(at)}#${msgId}`;
const notifyKey = (dueAt: number, storeId: string, id: string) => ({ pk: NOTIFY_PK, sk: `${ts(dueAt)}#STORE#${storeId}#${id}` });
const reportKey = (storeId: string, id: string) => ({ pk: REPORT_PK, sk: `STORE#${storeId}#CONVO#${id}` });

/** A message cursor from the client: one of this conversation's sort keys. */
export function isMessageCursor(id: string, v: unknown): v is string {
  return typeof v === "string" && v.length < 120 && v.startsWith(msgPrefix(id)) && /^\d{13}#[0-9A-HJKMNP-TV-Z]{26}$/.test(v.slice(msgPrefix(id).length));
}
/** An inbox cursor: a CONVO_ACT / CONVO_UNREAD sort key. */
export function isInboxCursor(v: unknown): v is string {
  return typeof v === "string" && /^(CONVO_ACT#\d{13}#|CONVO_UNREAD#)[0-9A-HJKMNP-TV-Z]{26}$/.test(v);
}

/** The inbox line for a message: its text, or a photo note. */
export function previewOf(body: string, images: number): string {
  const text = body.replace(/\s+/g, " ").trim().slice(0, 140);
  if (text) return text;
  return images > 1 ? `📷 ${images} photos` : "📷 Photo";
}

/** Plain text: no control characters, at most one blank line in a row, trimmed (the reviews' rule). */
export const cleanMessageText = cleanReviewText;

/** The folder a conversation's photos are uploaded to (and the only one its messages may use). */
export const messageImageFolder = (storeId: string, id: string) => `store/${storeId}/messages/${id}/`;
export function isMessageImageKey(storeId: string, id: string, key: unknown): key is string {
  const folder = messageImageFolder(storeId, id);
  return typeof key === "string" && key.startsWith(folder) && /^[0-9A-HJKMNP-TV-Z]{26}\.(png|jpg)$/.test(key.slice(folder.length));
}

const fromRow = (r: Record<string, unknown>): Conversation => ({
  conversationId: String(r.conversationId),
  storeId: String(r.storeId),
  kind: r.kind === "ORDER" ? "ORDER" : "INQUIRY",
  orderId: (r.orderId as string) || null,
  orderCode: (r.orderCode as string) || null,
  customerName: String(r.customerName ?? ""),
  customerEmail: String(r.customerEmail ?? ""),
  status: r.status === "BLOCKED" ? "BLOCKED" : "OPEN",
  messageCount: Number(r.messageCount ?? 0),
  lastAt: Number(r.lastAt ?? 0),
  lastFrom: r.lastFrom === "STORE" ? "STORE" : "CUSTOMER",
  preview: String(r.preview ?? ""),
  storeUnread: Number(r.storeUnread ?? 0),
  customerUnread: Number(r.customerUnread ?? 0),
  storeReadAt: Number(r.storeReadAt ?? 0),
  customerReadAt: Number(r.customerReadAt ?? 0),
  customerEmailedAt: Number(r.customerEmailedAt ?? 0),
  createdAt: Number(r.createdAt ?? 0),
  report: (r.report as ConversationReport) ?? null,
  customerTokenHashes: Array.isArray(r.customerTokenHashes) ? (r.customerTokenHashes as string[]) : [],
  actSk: String(r.actSk ?? ""),
});

const msgFromRow = (r: Record<string, unknown>): ConversationMessage => ({
  messageId: String(r.messageId),
  from: r.from === "STORE" ? "STORE" : "CUSTOMER",
  authorName: String(r.authorName ?? ""),
  body: String(r.body ?? ""),
  images: Array.isArray(r.images) ? (r.images as string[]) : [],
  at: Number(r.at ?? 0),
  ...(typeof r.byUserId === "string" ? { byUserId: r.byUserId } : {}),
  cursor: String(r.sk),
});

export async function getConversation(storeId: string, id: string): Promise<Conversation | null> {
  const r = (await ddb.send(new GetCommand({ TableName: TABLE, Key: convoKey(storeId, id), ConsistentRead: true }))).Item;
  return r ? fromRow(r) : null;
}

/** A new token for an inquiry's shopper: `token` goes to them, `hash` is kept. */
export function newConversationToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: hashStatusToken(token) };
}

export function conversationTokenMatches(c: Conversation, token: string): boolean {
  if (!token || token.length > 64) return false;
  const h = hashStatusToken(token);
  return (c.customerTokenHashes ?? []).includes(h);
}

/** Keep another token hash for an inquiry (the newest MAX_TOKENS). */
export async function addConversationToken(storeId: string, id: string, hash: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const c = await getConversation(storeId, id);
    if (!c) throw new Error("Conversation not found");
    const old = c.customerTokenHashes ?? [];
    const next = [...old, hash].slice(-MAX_TOKENS);
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: convoKey(storeId, id),
          UpdateExpression: "SET customerTokenHashes = :next",
          ConditionExpression: "attribute_exists(pk) AND size(customerTokenHashes) = :n",
          ExpressionAttributeValues: { ":next": next, ":n": old.length },
        })
      );
      return;
    } catch (e) {
      if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
    }
  }
  throw new Error("Conversation tokens kept changing");
}

export interface NewMessage {
  from: MessageFrom;
  authorName: string;
  body: string;
  images: string[];
  byUserId?: string;
}

/** The conversation can't take messages (an admin blocked it). */
export class ConversationClosedError extends Error {}

/*
 * Start a conversation with its first message. `exists` is thrown as ConversationExistsError when
 * the id is taken (an order conversation someone else started a moment ago): the caller then
 * sends to it instead.
 */
export class ConversationExistsError extends Error {}
export async function createConversation(
  input: {
    storeId: string;
    conversationId?: string;
    kind: ConversationKind;
    orderId: string | null;
    orderCode: string | null;
    customerName: string;
    customerEmail: string;
    tokenHash?: string;
  },
  first: NewMessage,
  now: number
): Promise<{ conversation: Conversation; message: ConversationMessage }> {
  const id = input.conversationId ?? ULID.ulid(now);
  const msgId = ULID.ulid(now);
  const fromCustomer = first.from === "CUSTOMER";
  const conversation: Conversation = {
    conversationId: id,
    storeId: input.storeId,
    kind: input.kind,
    orderId: input.orderId,
    orderCode: input.orderCode,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    status: "OPEN",
    messageCount: 1,
    lastAt: now,
    lastFrom: first.from,
    preview: previewOf(first.body, first.images.length),
    storeUnread: fromCustomer ? 1 : 0,
    customerUnread: fromCustomer ? 0 : 1,
    storeReadAt: fromCustomer ? 0 : now,
    customerReadAt: fromCustomer ? now : 0,
    customerEmailedAt: 0,
    createdAt: now,
    report: null,
    ...(input.tokenHash ? { customerTokenHashes: [input.tokenHash] } : { customerTokenHashes: [] }),
    actSk: actSkOf(now, id),
  };
  const sk = msgSk(id, now, msgId);
  const message: ConversationMessage = { messageId: msgId, ...first, at: now, cursor: sk };
  const { cursor: _c, ...messageRow } = message;
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: TABLE, Item: { ...convoKey(input.storeId, id), ...conversation }, ConditionExpression: "attribute_not_exists(pk)" } },
          { Put: { TableName: TABLE, Item: { pk: storePk(input.storeId), sk: conversation.actSk, conversationId: id } } },
          { Put: { TableName: TABLE, Item: { pk: storePk(input.storeId), sk, ...messageRow } } },
          ...(fromCustomer
            ? [
                { Put: { TableName: TABLE, Item: { ...unreadKey(input.storeId, id), conversationId: id, since: now } } },
                { Put: { TableName: TABLE, Item: { ...notifyKey(now + STORE_EMAIL_DELAY_MS, input.storeId, id), storeId: input.storeId, conversationId: id } } },
              ]
            : []),
        ],
      })
    );
  } catch (e) {
    const reasons = (e as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
    if ((e as { name?: string }).name === "TransactionCanceledException" && reasons?.[0]?.Code === "ConditionalCheckFailed") {
      throw new ConversationExistsError("Conversation exists");
    }
    throw e;
  }
  return { conversation, message };
}

/*
 * Add a message. Optimistic on the conversation's activity row (retried with a fresh read when
 * another message got there first). A shopper message marks it unread for the store and, if it
 * wasn't already, queues the store's email; a store message marks it unread for the shopper.
 */
export async function addMessage(
  storeId: string,
  id: string,
  msg: NewMessage,
  now: number
): Promise<{ conversation: Conversation; message: ConversationMessage; before: Conversation }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const c = await getConversation(storeId, id);
    if (!c) throw new Error("Conversation not found");
    if (c.status === "BLOCKED") throw new ConversationClosedError("Conversation is closed");
    const at = Math.max(now, c.lastAt + 1);
    const msgId = ULID.ulid(at);
    const fromCustomer = msg.from === "CUSTOMER";
    const newAct = actSkOf(at, id);
    const sk = msgSk(id, at, msgId);
    const message: ConversationMessage = { messageId: msgId, ...msg, at, cursor: sk };
    const { cursor: _c, ...messageRow } = message;
    const unreadField = fromCustomer ? "storeUnread" : "customerUnread";
    const readField = fromCustomer ? "customerReadAt" : "storeReadAt";
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: TABLE,
                Key: convoKey(storeId, id),
                // The sender has read everything up to their own message.
                UpdateExpression: `SET lastAt = :at, lastFrom = :from, preview = :pv, actSk = :act, ${readField} = :at, ${
                  fromCustomer ? "customerUnread" : "storeUnread"
                } = :zero ADD messageCount :one, ${unreadField} :one`,
                ConditionExpression: "attribute_exists(pk) AND actSk = :oldAct AND #st <> :blocked",
                ExpressionAttributeNames: { "#st": "status" },
                ExpressionAttributeValues: {
                  ":at": at,
                  ":from": msg.from,
                  ":pv": previewOf(msg.body, msg.images.length),
                  ":act": newAct,
                  ":oldAct": c.actSk,
                  ":blocked": "BLOCKED",
                  ":one": 1,
                  ":zero": 0,
                },
              },
            },
            { Delete: { TableName: TABLE, Key: { pk: storePk(storeId), sk: c.actSk } } },
            { Put: { TableName: TABLE, Item: { pk: storePk(storeId), sk: newAct, conversationId: id } } },
            { Put: { TableName: TABLE, Item: { pk: storePk(storeId), sk, ...messageRow } } },
            ...(fromCustomer
              ? [
                  {
                    Update: {
                      TableName: TABLE,
                      Key: unreadKey(storeId, id),
                      UpdateExpression: "SET conversationId = :id, since = if_not_exists(since, :at)",
                      ExpressionAttributeValues: { ":id": id, ":at": at },
                    },
                  },
                  // The store's email: queued with its first unread message only.
                  ...(c.storeUnread === 0
                    ? [{ Put: { TableName: TABLE, Item: { ...notifyKey(at + STORE_EMAIL_DELAY_MS, storeId, id), storeId, conversationId: id } } }]
                    : []),
                ]
              : // Replying reads the shopper's messages.
                [{ Delete: { TableName: TABLE, Key: unreadKey(storeId, id) } }]),
          ],
        })
      );
    } catch (e) {
      if ((e as { name?: string }).name === "TransactionCanceledException") {
        const fresh = await getConversation(storeId, id);
        if (fresh?.status === "BLOCKED") throw new ConversationClosedError("Conversation is closed");
        continue; // someone else's message got there first
      }
      throw e;
    }
    const conversation: Conversation = {
      ...c,
      lastAt: at,
      lastFrom: msg.from,
      preview: previewOf(msg.body, msg.images.length),
      actSk: newAct,
      messageCount: c.messageCount + 1,
      storeUnread: fromCustomer ? c.storeUnread + 1 : 0,
      customerUnread: fromCustomer ? 0 : c.customerUnread + 1,
      ...(fromCustomer ? { customerReadAt: at } : { storeReadAt: at }),
    };
    return { conversation, message, before: c };
  }
  throw new Error("Conversation kept changing while sending");
}

/** Messages, newest first, older than `before` (a cursor) or the newest page. */
export async function listMessages(
  storeId: string,
  id: string,
  opts: { before?: string; after?: string; limit?: number } = {}
): Promise<{ messages: ConversationMessage[]; older: string | null }> {
  const limit = opts.limit ?? MESSAGE_PAGE;
  if (opts.after) {
    // Polling: everything newer than what the client has, oldest first (at most a page).
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :a AND :z",
        ExpressionAttributeValues: { ":pk": storePk(storeId), ":a": opts.after, ":z": `${msgPrefix(id)}~` },
        Limit: limit + 1,
      })
    );
    const rows = (res.Items ?? []).filter((r) => r.sk !== opts.after).map(msgFromRow);
    return { messages: rows.reverse(), older: null };
  }
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :a AND :z",
      ExpressionAttributeValues: { ":pk": storePk(storeId), ":a": msgPrefix(id), ":z": opts.before ?? `${msgPrefix(id)}~` },
      ScanIndexForward: false,
      Limit: limit + 1,
    })
  );
  const rows = (res.Items ?? []).filter((r) => r.sk !== opts.before).map(msgFromRow);
  const page = rows.slice(0, limit);
  return { messages: page, older: rows.length > limit && page.length ? page[page.length - 1].cursor : null };
}

const newestFirst = (a: Conversation, b: Conversation) => b.lastAt - a.lastAt || b.conversationId.localeCompare(a.conversationId);

/*
 * The store's inbox: newest activity first, a page at a time (`cursor` from the last page).
 * `unread` lists only the conversations with shopper messages the store hasn't read.
 */
export async function listConversations(
  storeId: string,
  opts: { unread?: boolean; cursor?: string; limit?: number } = {}
): Promise<{ conversations: Conversation[]; next: string | null }> {
  const limit = opts.limit ?? CONVERSATION_PAGE;
  const prefix = opts.unread ? "CONVO_UNREAD#" : "CONVO_ACT#";
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)",
      ExpressionAttributeValues: { ":pk": storePk(storeId), ":p": prefix },
      ScanIndexForward: false,
      Limit: limit,
      ...(opts.cursor && opts.cursor.startsWith(prefix) ? { ExclusiveStartKey: { pk: storePk(storeId), sk: opts.cursor } } : {}),
    })
  );
  const ids = (res.Items ?? []).map((r) => String(r.conversationId));
  const rows = ids.length ? await dynamGetManyItems(TABLE, ids.map((id) => convoKey(storeId, id))) : [];
  const next = res.LastEvaluatedKey ? String(res.LastEvaluatedKey.sk) : null;
  return { conversations: rows.map(fromRow).sort(newestFirst), next };
}

/** Conversations with shopper messages the store hasn't read (the menu badge). */
export async function countUnreadConversations(storeId: string): Promise<number> {
  let n = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)",
        ExpressionAttributeValues: { ":pk": storePk(storeId), ":p": "CONVO_UNREAD#" },
        Select: "COUNT",
        ...(start ? { ExclusiveStartKey: start } : {}),
      })
    );
    n += res.Count ?? 0;
    start = res.LastEvaluatedKey;
  } while (start);
  return n;
}

/** The store read it: no unread for the store, the menu badge drops it. */
export async function markReadByStore(storeId: string, id: string, now: number): Promise<void> {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: convoKey(storeId, id),
            UpdateExpression: "SET storeUnread = :zero, storeReadAt = :now",
            ConditionExpression: "attribute_exists(pk)",
            ExpressionAttributeValues: { ":zero": 0, ":now": now },
          },
        },
        { Delete: { TableName: TABLE, Key: unreadKey(storeId, id) } },
      ],
    })
  );
}

/** The shopper read it. */
export async function markReadByCustomer(storeId: string, id: string, now: number): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: convoKey(storeId, id),
      UpdateExpression: "SET customerUnread = :zero, customerReadAt = :now",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":zero": 0, ":now": now },
    })
  );
}

/*
 * Should the shopper get an email about a store reply? Once per unread stretch: not again until
 * they've read the conversation. Claims it (conditional), so two replies can't both send.
 */
export async function claimCustomerEmail(storeId: string, id: string, now: number): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: convoKey(storeId, id),
        UpdateExpression: "SET customerEmailedAt = :now",
        ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(customerEmailedAt) OR customerEmailedAt <= customerReadAt)",
        ExpressionAttributeValues: { ":now": now },
      })
    );
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/** Store emails whose time has come (oldest first). */
export async function listDueStoreEmails(now: number, limit = 50): Promise<Array<{ storeId: string; conversationId: string; sk: string }>> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND sk <= :now",
      ExpressionAttributeValues: { ":pk": NOTIFY_PK, ":now": `${ts(now)}#~` },
      Limit: limit,
    })
  );
  return (res.Items ?? []).map((r) => ({ storeId: String(r.storeId), conversationId: String(r.conversationId), sk: String(r.sk) }));
}

export async function deleteDueStoreEmail(sk: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: NOTIFY_PK, sk } }));
}

/** Already reported (or decided): it can't be reported again. */
export class ConversationReportRefusedError extends Error {}

export async function reportConversation(
  c: Conversation,
  reason: ConvoReportReason,
  note: string,
  byUserId: string,
  storeName: string,
  now: number
): Promise<void> {
  const report: ConversationReport = { reason, note, byUserId, at: now };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: convoKey(c.storeId, c.conversationId),
              UpdateExpression: "SET report = :r",
              ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(report) OR report = :null)",
              ExpressionAttributeValues: { ":r": report, ":null": null },
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: {
                ...reportKey(c.storeId, c.conversationId),
                storeId: c.storeId,
                conversationId: c.conversationId,
                storeName,
                customerName: c.customerName,
                orderCode: c.orderCode,
                reason,
                note,
                reportedAt: now,
              },
            },
          },
        ],
      })
    );
  } catch (e) {
    if ((e as { name?: string }).name === "TransactionCanceledException") throw new ConversationReportRefusedError("Already reported");
    throw e;
  }
}

export interface ConversationReportRow {
  storeId: string;
  conversationId: string;
  storeName: string;
  customerName: string;
  orderCode: string | null;
  reason: ConvoReportReason;
  note: string;
  reportedAt: number;
}

export async function listConversationReports(): Promise<ConversationReportRow[]> {
  const out: ConversationReportRow[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": REPORT_PK },
        ...(start ? { ExclusiveStartKey: start } : {}),
      })
    );
    for (const r of res.Items ?? []) {
      out.push({
        storeId: String(r.storeId),
        conversationId: String(r.conversationId),
        storeName: String(r.storeName ?? ""),
        customerName: String(r.customerName ?? ""),
        orderCode: (r.orderCode as string) || null,
        reason: r.reason as ConvoReportReason,
        note: String(r.note ?? ""),
        reportedAt: Number(r.reportedAt ?? 0),
      });
    }
    start = res.LastEvaluatedKey;
  } while (start && out.length < 1000);
  return out.sort((a, b) => a.reportedAt - b.reportedAt);
}

export class ConversationReportChangedError extends Error {}

/** An admin's decision: DISMISS (stays open) or BLOCK (nobody can send any more). */
export async function decideConversationReport(storeId: string, id: string, decision: "DISMISS" | "BLOCK", now: number): Promise<void> {
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: { TableName: TABLE, Key: reportKey(storeId, id), ConditionExpression: "attribute_exists(pk)" },
          },
          {
            Update: {
              TableName: TABLE,
              Key: convoKey(storeId, id),
              UpdateExpression: `SET report.decision = :d, report.decidedAt = :now${decision === "BLOCK" ? ", #st = :blocked" : ""}`,
              ConditionExpression: "attribute_exists(pk)",
              ...(decision === "BLOCK" ? { ExpressionAttributeNames: { "#st": "status" } } : {}),
              ExpressionAttributeValues: { ":d": decision, ":now": now, ...(decision === "BLOCK" ? { ":blocked": "BLOCKED" } : {}) },
            },
          },
        ],
      })
    );
  } catch (e) {
    if ((e as { name?: string }).name === "TransactionCanceledException") {
      // The conversation is gone (store deleted): drop the stale report row.
      const left = await getConversation(storeId, id);
      if (!left) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: reportKey(storeId, id) }));
      throw new ConversationReportChangedError("No open report for this conversation");
    }
    throw e;
  }
}

/** Tests only. */
export const _keys = { convoKey, unreadKey, notifyKey, reportKey, actSkOf, msgSk };
