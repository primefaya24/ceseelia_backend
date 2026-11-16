import { Request, Response, Router } from "express";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../../layers/core/http/cache";
import { countUnreadConversations } from "../../../../../layers/aws/dynamodb/dynamo-entities/conversation";
import { sendServerError } from "../../../admin/route-errors";

/* GET /store/messages/unread/:storeId (store members; L.10) → { unread }: for the menu badge (polled). */
export default function registerRoute(router: Router): void {
  router.get("/unread/:storeId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, () => true, () => true, executeRouteCore, true, storeMember((req) => req.params.storeId));
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    res.send({ unread: await countUnreadConversations(String(req.params.storeId)) });
  } catch (e) {
    sendServerError(e, res, "In store/messages/unread");
  }
}
