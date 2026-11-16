import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { getAuth, storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { isUlid } from "../../../../../layers/core/utils";
import { markImagesKept } from "../../../../../layers/aws/s3/image-upload";
import { getStoreOverviewRow } from "../../../../../layers/aws/dynamodb/dynamo-entities/membership";
import { getOrderById } from "../../../../../layers/aws/dynamodb/dynamo-entities/order";
import {
  Conversation,
  ConversationClosedError,
  ConversationExistsError,
  ConversationMessage,
  addMessage,
  createConversation,
  getConversation,
} from "../../../../../layers/aws/dynamodb/dynamo-entities/conversation";
import { isOutgoingPure, messageLimits, outgoingMessage, storeConversationView, storeMessageView } from "../../../../../layers/core/messages";
import { notifyShopperOfReply } from "../../../../../layers/notifications/message-notify";
import { sendServerError } from "../../../admin/route-errors";

/*
 * POST /store/messages/send { storeId, conversationId, body?, images? } (store members; L.10)
 *   → 201 { conversation, message }. Text ≤ 2,000 and/or up to 4 photos uploaded with
 *   image-upload-urls. `conversationId` an existing conversation, or a paid order of this store
 *   (starts that order's conversation). The shopper gets an email (once until they've read it).
 *   404 CONVERSATION_NOT_FOUND, 409 CONVERSATION_CLOSED (blocked by Ceseelia), 429 RATE_LIMITED.
 */
export default function registerRoute(router: Router): void {
  router.post("/send", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => typeof req.body?.conversationId === "string" && isOutgoingPure(req.body),
      (req) => isUlid(req.body.conversationId) && outgoingMessage(String(req.body.storeId), req.body.conversationId, req.body) !== null,
      executeRouteCore,
      true,
      storeMember((req) => req.body?.storeId)
    );
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  const storeId = String(req.body.storeId);
  const id = String(req.body.conversationId);
  const out = outgoingMessage(storeId, id, req.body)!;
  const limited = messageLimits.storeSendPerStore.take(`store:${storeId}`);
  if (!limited.ok) {
    res.set("Retry-After", String(limited.retryAfterSeconds));
    res.status(429).send({ code: "RATE_LIMITED", message: "Too many messages. Please try again shortly." });
    return;
  }
  const notFound = () =>
    res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" });
  try {
    const auth = getAuth(res);
    const storeName = String((await getStoreOverviewRow(storeId))?.storeName ?? "") || "The store";
    const msg = { from: "STORE" as const, authorName: storeName, body: out.body, images: out.images, byUserId: auth.userId ?? (auth.isAdmin ? "ADMIN" : auth.cognitoId) };
    await markImagesKept(out.images);
    const now = Date.now();
    let result: { conversation: Conversation; message: ConversationMessage };
    const existing = await getConversation(storeId, id);
    if (existing) {
      result = await addMessage(storeId, id, msg, now);
    } else {
      const order = await getOrderById(id);
      if (!order || order.storeId !== storeId || typeof order.storeOrderPaidAt !== "number") {
        notFound();
        return;
      }
      try {
        result = await createConversation(
          {
            storeId,
            conversationId: id,
            kind: "ORDER",
            orderId: order.storeOrderId,
            orderCode: order.storeOrderCode,
            customerName: order.storeOrderCustomer.name,
            customerEmail: order.storeOrderCustomer.email,
          },
          msg,
          now
        );
      } catch (e) {
        if (!(e instanceof ConversationExistsError)) throw e;
        result = await addMessage(storeId, id, msg, now); // the shopper started it a moment ago
      }
    }
    void notifyShopperOfReply(result.conversation);
    res.status(201).send({ conversation: storeConversationView(result.conversation), message: storeMessageView(result.message) });
  } catch (e) {
    if (e instanceof ConversationClosedError) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code: "CONVERSATION_CLOSED", message: "This conversation was closed by Ceseelia." });
      return;
    }
    sendServerError(e, res, "In store/messages/send");
  }
}
