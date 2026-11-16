import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { isUlid } from "../../../../layers/core/utils";
import { ConversationReportChangedError, decideConversationReport } from "../../../../layers/aws/dynamodb/dynamo-entities/conversation";
import { log } from "../../../../layers/core/logger";
import { sendServerError } from "../route-errors";

/*
 * POST /admin/decide-message-report { storeId, conversationId, decision: DISMISS | BLOCK }
 * (admins; L.10) → { decision }. DISMISS: it stays open and can't be reported again. BLOCK:
 * nobody can send in it any more (both sides still read it). 409 REPORT_CHANGED if there's no
 * open report.
 */
export default function registerRoute(router: Router): void {
  router.post("/decide-message-report", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => isUlid(req.body?.storeId) && isUlid(req.body?.conversationId) && typeof req.body?.decision === "string",
      (req) => req.body.decision === "DISMISS" || req.body.decision === "BLOCK",
      executeRouteCore,
      true,
      /* admins only */ true
    );
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    await decideConversationReport(String(req.body.storeId), String(req.body.conversationId), req.body.decision, Date.now());
    log.info({ storeId: req.body.storeId, conversationId: req.body.conversationId, decision: req.body.decision }, "Conversation report decided");
    res.send({ decision: req.body.decision });
  } catch (e) {
    if (e instanceof ConversationReportChangedError) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code: "REPORT_CHANGED", message: e.message });
      return;
    }
    sendServerError(e, res, "In admin/decide-message-report");
  }
}
