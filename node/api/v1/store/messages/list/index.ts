import { Request, Response, Router } from "express";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../../layers/core/http/cache";
import { countUnreadConversations, isInboxCursor, listConversations } from "../../../../../layers/aws/dynamodb/dynamo-entities/conversation";
import { storeConversationView } from "../../../../../layers/core/messages";
import { sendServerError } from "../../../admin/route-errors";

/*
 * GET /store/messages/list/:storeId?filter=all|unread&cursor= (store members; L.10)
 *   → { conversations, next, unread }: the inbox, newest activity first, 20 a page (`next` is the
 *   cursor for the next page, null at the end); `unread` = conversations the store hasn't read.
 */
export default function registerRoute(router: Router): void {
  router.get("/list/:storeId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => (req.query.filter === undefined || typeof req.query.filter === "string") && (req.query.cursor === undefined || typeof req.query.cursor === "string"),
      (req) => (req.query.filter === undefined || req.query.filter === "all" || req.query.filter === "unread") && (req.query.cursor === undefined || isInboxCursor(req.query.cursor)),
      executeRouteCore,
      true,
      storeMember((req) => req.params.storeId)
    );
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const storeId = String(req.params.storeId);
  try {
    const [page, unread] = await Promise.all([
      listConversations(storeId, { unread: req.query.filter === "unread", cursor: req.query.cursor as string | undefined }),
      countUnreadConversations(storeId),
    ]);
    res.send({ conversations: page.conversations.map(storeConversationView), next: page.next, unread });
  } catch (e) {
    sendServerError(e, res, "In store/messages/list");
  }
}
