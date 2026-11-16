import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { MAX_LENGTH } from "../../../../constants/input-limits";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { sendPublicError } from "../../../../layers/core/http/public-storefront";
import { RateLimiter } from "../../../../layers/core/http/rate-limit";
import { getClientIp, isUlid } from "../../../../layers/core/utils";
import { isEmailOrEmpty } from "../../../../layers/core/utils/validation";
import { StoreOrder } from "../../../../layers/core/interfaces/store";
import { getPublicStoreSettings } from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { getStoreOverviewRow } from "../../../../layers/aws/dynamodb/dynamo-entities/membership";
import { getOrderById, orderTokenMatches } from "../../../../layers/aws/dynamodb/dynamo-entities/order";
import { createImageUploads, markImagesKept, parseUploadCount } from "../../../../layers/aws/s3/image-upload";
import {
  Conversation,
  ConversationClosedError,
  ConversationExistsError,
  ConversationMessage,
  MAX_MESSAGE_IMAGES,
  addMessage,
  cleanMessageText,
  conversationTokenMatches,
  createConversation,
  getConversation,
  isMessageCursor,
  listMessages,
  markReadByCustomer,
  messageImageFolder,
  newConversationToken,
} from "../../../../layers/aws/dynamodb/dynamo-entities/conversation";
import {
  emptyOrderConversationView,
  isOutgoingPure,
  messageLimits,
  outgoingMessage,
  shopperConversationView,
  shopperMessageView,
} from "../../../../layers/core/messages";
import { notifyStoreOfMessage, sendInquiryLink } from "../../../../layers/notifications/message-notify";
import { log } from "../../../../layers/core/logger";

/*
 * Shopper messages (progress.md L.10; no account). The shopper proves who they are with the
 * header `X-Conversation-Token`: for an order's conversation (its id = the order id) the order's
 * own token (checkout or an order email), for an inquiry one of its tokens (the browser that
 * started it, or an email link). A wrong token and an unknown conversation are the same 404
 * CONVERSATION_NOT_FOUND.
 *
 *   POST /customer/messages/start { storeId, name, email, body, website } → 201
 *        { conversationId, token, conversation, messages }: Contact us. A live store only; the
 *        shopper gets their link by email. `website` is a honeypot (filled → 200, nothing saved).
 *   GET  /customer/messages/thread/:storeId/:conversationId?before=&after=
 *        → { conversation, messages, older } (newest first, 30 a page; `after` polls)
 *   POST /customer/messages/send { storeId, conversationId, body?, images? } → 201 { conversation, message }
 *        (starts an order's conversation on its first message; paid orders only)
 *   POST /customer/messages/read { storeId, conversationId } → { read: true }
 *   GET  /customer/messages/image-upload-urls/:storeId/:conversationId/:pngCount/:jpgCount
 *
 * Limits: start 5/IP/10 min and 60/store/hour; sends and uploads 30/IP/10 min and 40 per
 * conversation an hour; reads 120/IP/min. 409 CONVERSATION_CLOSED once Ceseelia blocked it.
 */
export default function registerRoute(router: Router): void {
  router.post("/messages/start", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureStart, validStart, startCore, false);
  });
  router.get("/messages/thread/:storeId/:conversationId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureThread, validThread, threadCore, false);
  });
  router.post("/messages/send", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => hasToken(req) && typeof req.body?.storeId === "string" && typeof req.body?.conversationId === "string" && isOutgoingPure(req.body),
      (req) => isUlid(req.body.storeId) && isUlid(req.body.conversationId) && outgoingMessage(req.body.storeId, req.body.conversationId, req.body) !== null,
      sendCore,
      false
    );
  });
  router.post("/messages/read", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => hasToken(req) && typeof req.body?.storeId === "string" && typeof req.body?.conversationId === "string",
      (req) => isUlid(req.body.storeId) && isUlid(req.body.conversationId),
      readCore,
      false
    );
  });
  router.get("/messages/image-upload-urls/:storeId/:conversationId/:pngCount/:jpgCount", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      hasToken,
      (req) => {
        const png = parseUploadCount(req.params.pngCount);
        const jpg = parseUploadCount(req.params.jpgCount);
        return isUlid(req.params.storeId) && isUlid(req.params.conversationId) && png !== null && jpg !== null && png + jpg >= 1 && png + jpg <= MAX_MESSAGE_IMAGES;
      },
      uploadCore,
      false
    );
  });
}

const tokenOf = (req: Request) => req.header("x-conversation-token") ?? "";
const hasToken = (req: Request) => {
  const t = req.header("x-conversation-token");
  return typeof t === "string" && t.length > 0 && t.length <= 64;
};
const ip = (req: Request) => `ip:${getClientIp(req) ?? "unknown"}`;
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
// eslint-disable-next-line no-control-regex
const hasControlChars = (s: string) => /[\u0000-\u001f\u007f]/.test(s);

function limited(res: Response, limiter: RateLimiter, key: string): boolean {
  const r = limiter.take(key);
  if (r.ok) return false;
  res.set("Retry-After", String(r.retryAfterSeconds));
  res.status(429).send({ code: "RATE_LIMITED", message: "Too many messages. Please try again later.", retryAfter: r.retryAfterSeconds });
  return true;
}

const notFound = (res: Response) =>
  res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" });
const closed = (res: Response) =>
  res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code: "CONVERSATION_CLOSED", message: "This conversation is closed." });

async function storeNames(storeId: string): Promise<{ storeName: string; storeSlug: string }> {
  const o = await getStoreOverviewRow(storeId);
  return { storeName: String(o?.storeName ?? ""), storeSlug: String(o?.storeSlug ?? "") };
}

/*
 * Who is asking: the conversation (if it exists yet) and, for an order's, the order. null = the
 * token doesn't open it (or it doesn't exist): the routes answer 404.
 */
type Access = { conversation: Conversation | null; order: StoreOrder | null };
async function shopperAccess(storeId: string, id: string, token: string): Promise<Access | null> {
  const c = await getConversation(storeId, id);
  if (c && c.kind === "INQUIRY") return conversationTokenMatches(c, token) ? { conversation: c, order: null } : null;
  // An order's conversation (started or not): the order's token.
  const order = await getOrderById(id);
  if (!order || order.storeId !== storeId || typeof order.storeOrderPaidAt !== "number" || !orderTokenMatches(order, token)) return null;
  return { conversation: c, order };
}

// ---- start (Contact us) ----

function pureStart(req: Request): boolean {
  const b = req.body ?? {};
  return (
    typeof b.storeId === "string" &&
    typeof b.name === "string" &&
    typeof b.email === "string" &&
    typeof b.body === "string" &&
    (b.website === undefined || typeof b.website === "string")
  );
}

function validStart(req: Request): boolean {
  const name = text(req.body.name);
  const email = text(req.body.email);
  const body = cleanMessageText(req.body.body);
  return (
    isUlid(req.body.storeId) &&
    name.length > 0 &&
    name.length <= MAX_LENGTH.personName &&
    !hasControlChars(name) &&
    email.length > 0 &&
    email.length <= MAX_LENGTH.email &&
    isEmailOrEmpty(email) &&
    !hasControlChars(email) &&
    body.length > 0 &&
    body.length <= MAX_LENGTH.contactMessage
  );
}

async function startCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const storeId = String(req.body.storeId);
  if (limited(res, messageLimits.startPerIp, ip(req))) return;
  if (text(req.body.website)) {
    // A bot: looks sent, nothing saved.
    res.status(201).send({ conversationId: null, token: null, conversation: null, messages: [] });
    return;
  }
  try {
    await getPublicStoreSettings(storeId); // a live, open store (404s otherwise)
    if (limited(res, messageLimits.startPerStore, `store:${storeId}`)) return;
    const name = text(req.body.name);
    const { token, hash } = newConversationToken();
    const { conversation, message } = await createConversation(
      {
        storeId,
        kind: "INQUIRY",
        orderId: null,
        orderCode: null,
        customerName: name,
        customerEmail: text(req.body.email).toLowerCase(),
        tokenHash: hash,
      },
      { from: "CUSTOMER", authorName: name, body: cleanMessageText(req.body.body), images: [] },
      Date.now()
    );
    const store = await storeNames(storeId);
    void sendInquiryLink(conversation);
    void notifyStoreOfMessage(conversation, store.storeName);
    log.info({ storeId, conversationId: conversation.conversationId }, "Conversation started");
    res.status(201).send({
      conversationId: conversation.conversationId,
      token,
      conversation: shopperConversationView(conversation, store),
      messages: [shopperMessageView(message)],
    });
  } catch (e) {
    sendPublicError(res, e);
  }
}

// ---- read the thread ----

const pureThread = (req: Request) =>
  hasToken(req) && (req.query.before === undefined || typeof req.query.before === "string") && (req.query.after === undefined || typeof req.query.after === "string");

function validThread(req: Request): boolean {
  const id = String(req.params.conversationId);
  return (
    isUlid(req.params.storeId) &&
    isUlid(id) &&
    !(req.query.before && req.query.after) &&
    (req.query.before === undefined || isMessageCursor(id, req.query.before)) &&
    (req.query.after === undefined || isMessageCursor(id, req.query.after))
  );
}

async function threadCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  if (limited(res, messageLimits.shopperReadPerIp, ip(req))) return;
  const storeId = String(req.params.storeId);
  const id = String(req.params.conversationId);
  try {
    const access = await shopperAccess(storeId, id, tokenOf(req));
    if (!access) {
      notFound(res);
      return;
    }
    const store = await storeNames(storeId);
    if (!access.conversation) {
      res.send({ conversation: emptyOrderConversationView(access.order!, store), messages: [], older: null });
      return;
    }
    const page = await listMessages(storeId, id, { before: req.query.before as string | undefined, after: req.query.after as string | undefined });
    res.send({
      conversation: shopperConversationView(access.conversation, store),
      messages: page.messages.map(shopperMessageView),
      older: page.older,
    });
  } catch (e) {
    log.error({ err: e }, "In customer/messages/thread");
    res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}

// ---- send ----

async function sendCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const storeId = String(req.body.storeId);
  const id = String(req.body.conversationId);
  if (limited(res, messageLimits.shopperSendPerIp, ip(req))) return;
  try {
    const access = await shopperAccess(storeId, id, tokenOf(req));
    if (!access) {
      notFound(res);
      return;
    }
    if (access.conversation?.status === "BLOCKED") {
      closed(res);
      return;
    }
    if (limited(res, messageLimits.shopperSendPerConversation, `convo:${id}`)) return;
    const out = outgoingMessage(storeId, id, req.body)!;
    const authorName = access.conversation?.customerName ?? access.order!.storeOrderCustomer.name;
    const msg = { from: "CUSTOMER" as const, authorName, body: out.body, images: out.images };
    await markImagesKept(out.images);
    const now = Date.now();
    let result: { conversation: Conversation; message: ConversationMessage };
    if (access.conversation) {
      result = await addMessage(storeId, id, msg, now);
    } else {
      const o = access.order!;
      try {
        result = await createConversation(
          {
            storeId,
            conversationId: id,
            kind: "ORDER",
            orderId: o.storeOrderId,
            orderCode: o.storeOrderCode,
            customerName: o.storeOrderCustomer.name,
            customerEmail: o.storeOrderCustomer.email,
          },
          msg,
          now
        );
      } catch (e) {
        if (!(e instanceof ConversationExistsError)) throw e;
        result = await addMessage(storeId, id, msg, now);
      }
    }
    const store = await storeNames(storeId);
    void notifyStoreOfMessage(result.conversation, store.storeName);
    res.status(201).send({ conversation: shopperConversationView(result.conversation, store), message: shopperMessageView(result.message) });
  } catch (e) {
    if (e instanceof ConversationClosedError) {
      closed(res);
      return;
    }
    log.error({ err: e }, "In customer/messages/send");
    res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}

// ---- read mark ----

async function readCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  if (limited(res, messageLimits.shopperReadPerIp, ip(req))) return;
  const storeId = String(req.body.storeId);
  const id = String(req.body.conversationId);
  try {
    const access = await shopperAccess(storeId, id, tokenOf(req));
    if (!access) {
      notFound(res);
      return;
    }
    if (access.conversation && access.conversation.customerUnread > 0) await markReadByCustomer(storeId, id, Date.now());
    res.send({ read: true });
  } catch (e) {
    log.error({ err: e }, "In customer/messages/read");
    res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}

// ---- photo uploads ----

async function uploadCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  if (limited(res, messageLimits.shopperSendPerIp, ip(req))) return;
  const storeId = String(req.params.storeId);
  const id = String(req.params.conversationId);
  try {
    const access = await shopperAccess(storeId, id, tokenOf(req));
    if (!access) {
      notFound(res);
      return;
    }
    if (access.conversation?.status === "BLOCKED") {
      closed(res);
      return;
    }
    res.send(await createImageUploads(messageImageFolder(storeId, id), parseUploadCount(req.params.pngCount)!, parseUploadCount(req.params.jpgCount)!));
  } catch (e) {
    log.error({ err: e }, "In customer/messages/image-upload-urls");
    res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
