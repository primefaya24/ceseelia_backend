import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../../layers/core/http/cache";
import { isUlid } from "../../../../../layers/core/utils";
import { getConversation, isMessageCursor, listMessages } from "../../../../../layers/aws/dynamodb/dynamo-entities/conversation";
import { getOrderById } from "../../../../../layers/aws/dynamodb/dynamo-entities/order";
import { storeConversationView, storeMessageView } from "../../../../../layers/core/messages";
import { sendServerError } from "../../../admin/route-errors";

/*
 * GET /store/messages/thread/:storeId/:conversationId?before=&after= (store members; L.10)
 *   → { conversation, messages, older }. Messages newest first, 30 a page; `before` = the
 *   `older` cursor for the page before; `after` = the newest cursor the chat has (polling: only
 *   what's newer). An order of this store with no conversation yet → { conversation: null,
 *   messages: [], older: null, order: { orderId, orderCode, customerName } } so the merchant can
 *   write first. Otherwise 404 CONVERSATION_NOT_FOUND. Doesn't mark anything read.
 */
export default function registerRoute(router: Router): void {
  router.get("/thread/:storeId/:conversationId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => (req.query.before === undefined || typeof req.query.before === "string") && (req.query.after === undefined || typeof req.query.after === "string"),
      (req) => {
        const id = String(req.params.conversationId);
        return (
          isUlid(id) &&
          !(req.query.before && req.query.after) &&
          (req.query.before === undefined || isMessageCursor(id, req.query.before)) &&
          (req.query.after === undefined || isMessageCursor(id, req.query.after))
        );
      },
      executeRouteCore,
      true,
      storeMember((req) => req.params.storeId)
    );
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const storeId = String(req.params.storeId);
  const id = String(req.params.conversationId);
  try {
    const c = await getConversation(storeId, id);
    if (!c) {
      const order = await getOrderById(id);
      if (order && order.storeId === storeId && typeof order.storeOrderPaidAt === "number") {
        res.send({
          conversation: null,
          messages: [],
          older: null,
          order: { orderId: order.storeOrderId, orderCode: order.storeOrderCode, customerName: order.storeOrderCustomer.name },
        });
        return;
      }
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" });
      return;
    }
    const page = await listMessages(storeId, id, { before: req.query.before as string | undefined, after: req.query.after as string | undefined });
    res.send({ conversation: storeConversationView(c), messages: page.messages.map(storeMessageView), older: page.older });
  } catch (e) {
    sendServerError(e, res, "In store/messages/thread");
  }
}
