import { WEBAPP_URL } from "../../config";
import { storeUrl } from "../core/store-url";
import { log } from "../core/logger";
import { addOrderLinkTokenHash, getOrderById, newStatusToken } from "../aws/dynamodb/dynamo-entities/order";
import { listStoreMembers } from "../aws/dynamodb/dynamo-entities/membership";
import {
  Conversation,
  addConversationToken,
  claimCustomerEmail,
  deleteDueStoreEmail,
  getConversation,
  listDueStoreEmails,
  newConversationToken,
} from "../aws/dynamodb/dynamo-entities/conversation";
import { inquiryStartedEmail, messageReplyEmail, storeMessageAlertEmail } from "./order-email-templates";
import { send, shopperFrom, storeFor } from "./order-emails";
import { pushToUser } from "./web-push";

/*
 * Message notifications (progress.md L.10). Best effort: nothing here throws.
 *   shopper writes → web push to the store's members now; an email to the store if it's still
 *     unread after 30 minutes (the sweep below; Settings can turn it off).
 *   store writes   → an email to the shopper with a fresh private link, once until they've read it.
 *   inquiry starts → the shopper gets their link by email (also proves the address is theirs).
 * Emails carry no message text.
 */
const base = () => WEBAPP_URL.replace(/\/$/, "");

/** Where the merchant reads a conversation. */
export const storeMessagesUrl = (storeId: string, conversationId: string) =>
  `${base()}/store/messages/${storeId}?c=${conversationId}`;

/* A fresh private link to the conversation for the shopper (the order page for an order's). */
export async function shopperConversationLink(c: Conversation, storeSlug: string): Promise<string> {
  if (c.kind === "ORDER" && c.orderId) {
    const order = await getOrderById(c.orderId);
    if (!order) throw new Error("Order not found");
    const { token, hash } = newStatusToken();
    await addOrderLinkTokenHash(order, hash);
    return `${storeUrl(storeSlug, `/order/${c.orderId}?messages=1`)}#t=${token}`;
  }
  const { token, hash } = newConversationToken();
  await addConversationToken(c.storeId, c.conversationId, hash);
  return `${storeUrl(storeSlug, `/messages/${c.conversationId}`)}#t=${token}`;
}

/** A shopper wrote: push to the members' browsers. */
export async function notifyStoreOfMessage(c: Conversation, storeName: string): Promise<void> {
  try {
    const members = await listStoreMembers(c.storeId);
    const payload = {
      title: storeName ? `New message · ${storeName}` : "New message",
      body: `${c.customerName}${c.orderCode ? ` · order #${c.orderCode}` : ""}: ${c.preview}`.slice(0, 160),
      url: `/store/messages/${c.storeId}?c=${c.conversationId}`,
      tag: `convo-${c.conversationId}`,
    };
    await Promise.all(members.map((m) => pushToUser(m.userId, payload)));
  } catch (e) {
    log.error({ err: e, storeId: c.storeId, conversationId: c.conversationId }, "[messages] push failed");
  }
}

/** The store wrote: email the shopper, unless they already have an unread notice. */
export async function notifyShopperOfReply(c: Conversation, now = Date.now()): Promise<void> {
  try {
    if (!c.customerEmail || c.status === "BLOCKED") return;
    if (!(await claimCustomerEmail(c.storeId, c.conversationId, now))) return;
    const store = await storeFor(c.storeId);
    const link = await shopperConversationLink(c, store.storeSlug);
    await send(c.customerEmail, shopperFrom(store), messageReplyEmail(store, c.orderCode, link));
  } catch (e) {
    log.error({ err: e, storeId: c.storeId, conversationId: c.conversationId }, "[messages] reply email failed");
  }
}

/** An inquiry was started: the shopper's link, by email. */
export async function sendInquiryLink(c: Conversation): Promise<void> {
  try {
    const store = await storeFor(c.storeId);
    const link = await shopperConversationLink(c, store.storeSlug);
    await send(c.customerEmail, shopperFrom(store), inquiryStartedEmail(store, link));
  } catch (e) {
    log.error({ err: e, storeId: c.storeId, conversationId: c.conversationId }, "[messages] inquiry email failed");
  }
}

/*
 * Every minute: conversations whose first unread shopper message is 30 minutes old. Still
 * unread → email the members and the store's contact email (unless Settings turned it off).
 */
export async function sweepMessageEmails(now = Date.now()): Promise<{ sent: number; skipped: number; failed: number }> {
  const r = { sent: 0, skipped: 0, failed: 0 };
  for (const due of await listDueStoreEmails(now)) {
    try {
      const c = await getConversation(due.storeId, due.conversationId);
      const store = c && c.storeUnread > 0 && c.status === "OPEN" ? await storeFor(c.storeId) : null;
      if (!c || !store || !store.emailMessageAlerts) {
        r.skipped++;
      } else {
        const members = await listStoreMembers(c.storeId);
        const email = storeMessageAlertEmail(store.storeName, c.customerName, c.orderCode, storeMessagesUrl(c.storeId, c.conversationId));
        const to = [...new Set([...members.map((m) => m.email), store.storeEmail].map((a) => a.trim().toLowerCase()).filter(Boolean))];
        await Promise.all(to.map((a) => send(a, "Ceseelia", email)));
        r.sent++;
      }
      await deleteDueStoreEmail(due.sk);
    } catch (e) {
      r.failed++;
      log.error({ err: e, storeId: due.storeId, conversationId: due.conversationId }, "[messages] store email failed");
    }
  }
  return r;
}
