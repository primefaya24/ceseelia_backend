import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { getAuth, storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { isUlid } from "../../../../../layers/core/utils";
import { getStoreOverviewRow } from "../../../../../layers/aws/dynamodb/dynamo-entities/membership";
import {
  CONVO_REPORT_REASONS,
  ConvoReportReason,
  ConversationReportRefusedError,
  cleanMessageText,
  getConversation,
  reportConversation,
} from "../../../../../layers/aws/dynamodb/dynamo-entities/conversation";
import { notifyConversationReported } from "../../../../../layers/notifications/admin-alerts";
import { log } from "../../../../../layers/core/logger";
import { sendServerError } from "../../../admin/route-errors";

const NOTE_MAX = 500;

/*
 * POST /store/messages/report { storeId, conversationId, reason, note? } (store members; L.10)
 *   → { reported: true }. Asks Ceseelia to look at a conversation (ABUSIVE, SPAM, SCAM, OTHER;
 *   a note is required for OTHER). It stays open until an admin dismisses the report or blocks
 *   it; once per conversation (409 ALREADY_REPORTED). Emails ADMIN_ALERT_EMAIL.
 */
export default function registerRoute(router: Router): void {
  router.post("/report", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => typeof req.body?.conversationId === "string" && typeof req.body?.reason === "string" && (req.body?.note === undefined || typeof req.body.note === "string"),
      (req) => isUlid(req.body.conversationId) && (CONVO_REPORT_REASONS as readonly string[]).includes(req.body.reason) && (req.body.note ?? "").length <= NOTE_MAX + 100,
      executeRouteCore,
      true,
      storeMember((req) => req.body?.storeId)
    );
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  const storeId = String(req.body.storeId);
  const reason = req.body.reason as ConvoReportReason;
  const note = cleanMessageText(String(req.body.note ?? "")).slice(0, NOTE_MAX);
  if (reason === "OTHER" && !note) {
    res.status(appConstants.HTTP_STATUS_CODE_BAD_REQUEST).send({ code: "NOTE_REQUIRED", message: "Tell us what's wrong with this conversation" });
    return;
  }
  try {
    const c = await getConversation(storeId, String(req.body.conversationId));
    if (!c) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" });
      return;
    }
    const auth = getAuth(res);
    const storeName = String((await getStoreOverviewRow(storeId))?.storeName ?? "");
    await reportConversation(c, reason, note, auth.userId ?? (auth.isAdmin ? "ADMIN" : auth.cognitoId), storeName, Date.now());
    log.info({ storeId, conversationId: c.conversationId, reason }, "Conversation reported");
    void notifyConversationReported(storeId, storeName, reason);
    res.send({ reported: true });
  } catch (e) {
    if (e instanceof ConversationReportRefusedError) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code: "ALREADY_REPORTED", message: "This conversation has already been reported" });
      return;
    }
    sendServerError(e, res, "In store/messages/report");
  }
}
