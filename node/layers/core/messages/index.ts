import {
  Conversation,
  ConversationMessage,
  MAX_MESSAGE_IMAGES,
  MAX_MESSAGE_LENGTH,
  cleanMessageText,
  isMessageImageKey,
} from "../../aws/dynamodb/dynamo-entities/conversation";
import { createRateLimiter } from "../http/rate-limit";

/*
 * Messages (progress.md L.10): what each side sees, and the checks on an outgoing message, shared
 * by the store and shopper routes.
 */

export const messageLimits = {
  /** Contact us: new conversations. */
  startPerIp: createRateLimiter({ windowMs: 10 * 60_000, max: 5 }),
  startPerStore: createRateLimiter({ windowMs: 60 * 60_000, max: 60 }),
  /** Shopper messages and uploads. */
  shopperSendPerIp: createRateLimiter({ windowMs: 10 * 60_000, max: 30 }),
  shopperSendPerConversation: createRateLimiter({ windowMs: 60 * 60_000, max: 40 }),
  /** Shopper reads (the chat polls while it's open). */
  shopperReadPerIp: createRateLimiter({ windowMs: 60_000, max: 120 }),
  /** Store messages. */
  storeSendPerStore: createRateLimiter({ windowMs: 10 * 60_000, max: 300 }),
};

/** The store's view: everything but the shopper's token hashes. */
export function storeConversationView(c: Conversation) {
  return {
    conversationId: c.conversationId,
    storeId: c.storeId,
    kind: c.kind,
    orderId: c.orderId,
    orderCode: c.orderCode,
    customerName: c.customerName,
    customerEmail: c.customerEmail,
    status: c.status,
    messageCount: c.messageCount,
    lastAt: c.lastAt,
    lastFrom: c.lastFrom,
    preview: c.preview,
    storeUnread: c.storeUnread,
    customerUnread: c.customerUnread,
    /** When the shopper last read it (a "Seen" mark under the store's messages). */
    customerReadAt: c.customerReadAt,
    createdAt: c.createdAt,
    report: c.report ? { reason: c.report.reason, at: c.report.at, decision: c.report.decision ?? null } : null,
  };
}

export function storeMessageView(m: ConversationMessage) {
  return { messageId: m.messageId, from: m.from, authorName: m.authorName, body: m.body, images: m.images, at: m.at, cursor: m.cursor };
}

/** The shopper's view: no email, no store-side counts or member ids. */
export function shopperConversationView(c: Conversation, store: { storeName: string; storeSlug: string }) {
  return {
    conversationId: c.conversationId,
    storeId: c.storeId,
    storeName: store.storeName,
    storeSlug: store.storeSlug,
    kind: c.kind,
    orderId: c.orderId,
    orderCode: c.orderCode,
    customerName: c.customerName,
    status: c.status,
    customerUnread: c.customerUnread,
    /** When the store last read it (a "Seen" mark under the shopper's messages). */
    storeReadAt: c.storeReadAt,
  };
}

export const shopperMessageView = storeMessageView;

/** An order conversation that hasn't started yet, as the shopper sees it. */
export function emptyOrderConversationView(
  order: { storeOrderId: string; storeId: string; storeOrderCode: string; storeOrderCustomer: { name: string } },
  store: { storeName: string; storeSlug: string }
) {
  return {
    conversationId: order.storeOrderId,
    storeId: order.storeId,
    storeName: store.storeName,
    storeSlug: store.storeSlug,
    kind: "ORDER" as const,
    orderId: order.storeOrderId,
    orderCode: order.storeOrderCode,
    customerName: order.storeOrderCustomer.name,
    status: "OPEN" as const,
    customerUnread: 0,
    storeReadAt: 0,
  };
}

/** Type check of `{ body, images }` in a send request. */
export function isOutgoingPure(b: unknown): boolean {
  const o = b as { body?: unknown; images?: unknown };
  return (
    !!o &&
    (o.body === undefined || typeof o.body === "string") &&
    (o.images === undefined || (Array.isArray(o.images) && o.images.length <= MAX_MESSAGE_IMAGES && o.images.every((k) => typeof k === "string")))
  );
}

/*
 * The message to save: text cleaned (≤ MAX_MESSAGE_LENGTH), photos only from this
 * conversation's upload folder (≤ MAX_MESSAGE_IMAGES, no repeats), and at least one of the two.
 * null = not valid.
 */
export function outgoingMessage(storeId: string, conversationId: string, b: { body?: string; images?: string[] }): { body: string; images: string[] } | null {
  const body = cleanMessageText(b.body ?? "");
  const images = [...new Set(b.images ?? [])];
  if (body.length > MAX_MESSAGE_LENGTH) return null;
  if (images.length > MAX_MESSAGE_IMAGES || !images.every((k) => isMessageImageKey(storeId, conversationId, k))) return null;
  if (!body && !images.length) return null;
  return { body, images };
}
