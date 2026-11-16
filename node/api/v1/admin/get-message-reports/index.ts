import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { listConversationReports } from "../../../../layers/aws/dynamodb/dynamo-entities/conversation";
import { sendServerError } from "../route-errors";

/*
 * GET /admin/get-message-reports (admins; L.10) → { reports }: conversations stores reported,
 * oldest first ({ storeId, conversationId, storeName, customerName, orderCode, reason, note,
 * reportedAt }). Read one with GET /store/messages/thread/:storeId/:conversationId.
 */
export default function registerRoute(router: Router): void {
  router.get("/get-message-reports", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, () => true, () => true, executeRouteCore, true, true);
  });
}

async function executeRouteCore(_req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    res.send({ reports: await listConversationReports() });
  } catch (e) {
    sendServerError(e, res, "In admin/get-message-reports");
  }
}
