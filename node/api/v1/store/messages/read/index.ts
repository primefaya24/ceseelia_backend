import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { getAuth, storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { isUlid } from "../../../../../layers/core/utils";
import { getConversation, markReadByStore } from "../../../../../layers/aws/dynamodb/dynamo-entities/conversation";
import { sendServerError } from "../../../admin/route-errors";

/*
 * POST /store/messages/read { storeId, conversationId } (store members; L.10) → { read: true }.
 * The store has read the conversation (the inbox and menu badge drop it). A platform admin
 * reading a reported conversation doesn't count: { read: false }.
 */
export default function registerRoute(router: Router): void {
  router.post("/read", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => typeof req.body?.conversationId === "string",
      (req) => isUlid(req.body.conversationId),
      executeRouteCore,
      true,
      storeMember((req) => req.body?.storeId)
    );
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  const storeId = String(req.body.storeId);
  const id = String(req.body.conversationId);
  try {
    if (getAuth(res).isAdmin) {
      res.send({ read: false });
      return;
    }
    const c = await getConversation(storeId, id);
    if (!c) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" });
      return;
    }
    if (c.storeUnread > 0) await markReadByStore(storeId, id, Date.now());
    res.send({ read: true });
  } catch (e) {
    sendServerError(e, res, "In store/messages/read");
  }
}
