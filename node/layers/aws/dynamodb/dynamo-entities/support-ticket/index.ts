import * as ULID from "ulid";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../../constants";
import { DB_TABLE_NAME } from "../../../../../config";
import { dynamGetManyItems } from "../../dynamo-batch-ops";

/*
 * Support tickets (progress.md L.8 / 8.3): a signed-in user writes to Ceseelia, the team answers.
 *   APP_TICKET / TICKET#<ticketId>          the ticket (for the admin list), see SupportTicket
 *   USER#<userId> / TICKET#<ticketId>        { ticketId } so a user lists their own
 *   TICKET#<ticketId> / MSG#<13-digit at>#<ulid>  one message { from, authorName, body, at }
 * Status: OPEN (waiting on Ceseelia) → ANSWERED (waiting on the user) → CLOSED. A reply from the
 * user opens it again; either side can close it; a reply to a closed ticket reopens it.
 */
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: appConstants.DEFAULT_REGION }));
const TABLE = DB_TABLE_NAME;
const APP = "APP_TICKET";

export const TICKET_CATEGORIES = ["ORDERS_PAYMENTS", "BILLING", "STORE_SETUP", "ACCOUNT", "OTHER"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export type TicketStatus = "OPEN" | "ANSWERED" | "CLOSED";
export type TicketFrom = "USER" | "ADMIN";
/** Enough for a long conversation; past it, open a new ticket. */
export const MAX_MESSAGES = 100;
/** A user's tickets not yet closed. */
export const MAX_OPEN_TICKETS = 10;

export interface SupportTicket {
  ticketId: string;
  userId: string;
  userEmail: string;
  userName: string;
  storeId: string | null;
  storeName: string | null;
  subject: string;
  category: TicketCategory;
  status: TicketStatus;
  messageCount: number;
  lastFrom: TicketFrom;
  /** The start of the newest message, for lists. */
  preview: string;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface TicketMessage {
  messageId: string;
  from: TicketFrom;
  authorName: string;
  body: string;
  at: number;
}

const ticketKey = (id: string) => ({ pk: APP, sk: `TICKET#${id}` });
const pointerKey = (userId: string, id: string) => ({ pk: `${appConstants.DYNAMO_ENTITY_USER}#${userId}`, sk: `TICKET#${id}` });
const messageKey = (id: string, at: number, msgId: string) => ({ pk: `TICKET#${id}`, sk: `MSG#${String(at).padStart(13, "0")}#${msgId}` });
const previewOf = (body: string) => body.replace(/\s+/g, " ").slice(0, 140);

export class TicketFullError extends Error {}

const fromRow = (r: Record<string, unknown>): SupportTicket => ({
  ticketId: String(r.ticketId),
  userId: String(r.userId),
  userEmail: String(r.userEmail ?? ""),
  userName: String(r.userName ?? ""),
  storeId: (r.storeId as string) || null,
  storeName: (r.storeName as string) || null,
  subject: String(r.subject ?? ""),
  category: (r.category as TicketCategory) ?? "OTHER",
  status: (r.status as TicketStatus) ?? "OPEN",
  messageCount: Number(r.messageCount ?? 0),
  lastFrom: (r.lastFrom as TicketFrom) ?? "USER",
  preview: String(r.preview ?? ""),
  createdAt: Number(r.createdAt ?? 0),
  updatedAt: Number(r.updatedAt ?? 0),
  closedAt: typeof r.closedAt === "number" ? r.closedAt : null,
});

export async function createTicket(input: {
  userId: string;
  userEmail: string;
  userName: string;
  storeId: string | null;
  storeName: string | null;
  subject: string;
  category: TicketCategory;
  body: string;
  now: number;
}): Promise<SupportTicket> {
  const ticketId = ULID.ulid(input.now);
  const msgId = ULID.ulid(input.now);
  const ticket: SupportTicket = {
    ticketId,
    userId: input.userId,
    userEmail: input.userEmail,
    userName: input.userName,
    storeId: input.storeId,
    storeName: input.storeName,
    subject: input.subject,
    category: input.category,
    status: "OPEN",
    messageCount: 1,
    lastFrom: "USER",
    preview: previewOf(input.body),
    createdAt: input.now,
    updatedAt: input.now,
    closedAt: null,
  };
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: { ...ticketKey(ticketId), ...ticket }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: TABLE, Item: { ...pointerKey(input.userId, ticketId), ticketId } } },
        {
          Put: {
            TableName: TABLE,
            Item: { ...messageKey(ticketId, input.now, msgId), messageId: msgId, from: "USER", authorName: input.userName, body: input.body, at: input.now },
          },
        },
      ],
    })
  );
  return ticket;
}

export async function getTicket(ticketId: string): Promise<SupportTicket | null> {
  const r = (await ddb.send(new GetCommand({ TableName: TABLE, Key: ticketKey(ticketId), ConsistentRead: true }))).Item;
  return r ? fromRow(r) : null;
}

export async function listTicketMessages(ticketId: string): Promise<TicketMessage[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :m)",
      ExpressionAttributeValues: { ":pk": `TICKET#${ticketId}`, ":m": "MSG#" },
      Limit: MAX_MESSAGES + 5,
    })
  );
  return (res.Items ?? []).map((r) => ({
    messageId: String(r.messageId),
    from: r.from as TicketFrom,
    authorName: String(r.authorName ?? ""),
    body: String(r.body ?? ""),
    at: Number(r.at ?? 0),
  }));
}

const newestFirst = (a: SupportTicket, b: SupportTicket) => b.updatedAt - a.updatedAt || b.ticketId.localeCompare(a.ticketId);

export async function listUserTickets(userId: string): Promise<SupportTicket[]> {
  const ids: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :t)",
        ExpressionAttributeValues: { ":pk": `${appConstants.DYNAMO_ENTITY_USER}#${userId}`, ":t": "TICKET#" },
        ...(start ? { ExclusiveStartKey: start } : {}),
      })
    );
    ids.push(...(res.Items ?? []).map((r) => String(r.ticketId)));
    start = res.LastEvaluatedKey;
  } while (start && ids.length < 500);
  if (!ids.length) return [];
  const rows = await dynamGetManyItems(TABLE, ids.map(ticketKey));
  return rows.map(fromRow).filter((t) => t.userId === userId).sort(newestFirst);
}

/** Every ticket (newest activity first), at most `cap`; `partial` when there were more. */
export async function listAllTickets(cap = 1000): Promise<{ tickets: SupportTicket[]; partial: boolean }> {
  const out: SupportTicket[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :t)",
        ExpressionAttributeValues: { ":pk": APP, ":t": "TICKET#" },
        ScanIndexForward: false,
        ...(start ? { ExclusiveStartKey: start } : {}),
      })
    );
    out.push(...(res.Items ?? []).map(fromRow));
    start = res.LastEvaluatedKey;
  } while (start && out.length < cap);
  return { tickets: out.slice(0, cap).sort(newestFirst), partial: !!start || out.length > cap };
}

/** Tickets not closed: the admin's to-do count. */
export async function countOpenTickets(): Promise<number> {
  let n = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :t)",
        FilterExpression: "#st = :open",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: { ":pk": APP, ":t": "TICKET#", ":open": "OPEN" },
        Select: "COUNT",
        ...(start ? { ExclusiveStartKey: start } : {}),
      })
    );
    n += res.Count ?? 0;
    start = res.LastEvaluatedKey;
  } while (start);
  return n;
}

/**
 * A message on a ticket. From the user it goes back to OPEN (also when closed), from an admin to
 * ANSWERED. Throws TicketFullError past MAX_MESSAGES (checked in the same write).
 */
export async function addTicketMessage(ticket: SupportTicket, from: TicketFrom, authorName: string, body: string, now: number): Promise<SupportTicket> {
  const msgId = ULID.ulid(now);
  const status: TicketStatus = from === "USER" ? "OPEN" : "ANSWERED";
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: ticketKey(ticket.ticketId),
              UpdateExpression: "SET #st = :st, lastFrom = :from, preview = :pv, updatedAt = :now, closedAt = :null ADD messageCount :one",
              ConditionExpression: "attribute_exists(pk) AND messageCount < :max",
              ExpressionAttributeNames: { "#st": "status" },
              ExpressionAttributeValues: { ":st": status, ":from": from, ":pv": previewOf(body), ":now": now, ":null": null, ":one": 1, ":max": MAX_MESSAGES },
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: { ...messageKey(ticket.ticketId, now, msgId), messageId: msgId, from, authorName, body, at: now },
            },
          },
        ],
      })
    );
  } catch (e) {
    if ((e as { name?: string }).name === "TransactionCanceledException") throw new TicketFullError("Ticket is full");
    throw e;
  }
  return { ...ticket, status, lastFrom: from, preview: previewOf(body), updatedAt: now, closedAt: null, messageCount: ticket.messageCount + 1 };
}

/** Close it (false if it already was). */
export async function closeTicket(ticketId: string, now: number): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: ticketKey(ticketId),
        UpdateExpression: "SET #st = :closed, closedAt = :now, updatedAt = :now",
        ConditionExpression: "attribute_exists(pk) AND #st <> :closed",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: { ":closed": "CLOSED", ":now": now },
      })
    );
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/*
 * L.9 account delete: remove every ticket the user opened, with its messages and their pointer.
 * The messages are the user's words (and may hold personal details), so nothing is kept.
 * Returns how many tickets went.
 */
export async function deleteUserTickets(userId: string): Promise<number> {
  const { dynamoWriteManyItems } = await import("../../dynamo-batch-ops");
  const tickets = await listUserTickets(userId);
  const deletes: Array<{ DeleteRequest: { Key: Record<string, string> } }> = [];
  for (const t of tickets) {
    let start: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :m)",
          ExpressionAttributeValues: { ":pk": `TICKET#${t.ticketId}`, ":m": "MSG#" },
          ProjectionExpression: "pk, sk",
          ...(start ? { ExclusiveStartKey: start } : {}),
        })
      );
      for (const r of res.Items ?? []) deletes.push({ DeleteRequest: { Key: { pk: String(r.pk), sk: String(r.sk) } } });
      start = res.LastEvaluatedKey;
    } while (start);
    deletes.push({ DeleteRequest: { Key: ticketKey(t.ticketId) } });
  }
  // Pointers go with the rest of the USER# rows; tickets someone else owns are never touched.
  if (deletes.length) await dynamoWriteManyItems(TABLE, deletes);
  return tickets.length;
}
