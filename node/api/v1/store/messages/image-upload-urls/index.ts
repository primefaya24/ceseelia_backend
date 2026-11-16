import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { isUlid } from "../../../../../layers/core/utils";
import { createImageUploads, parseUploadCount } from "../../../../../layers/aws/s3/image-upload";
import { MAX_MESSAGE_IMAGES, getConversation, messageImageFolder } from "../../../../../layers/aws/dynamodb/dynamo-entities/conversation";
import { getOrderById } from "../../../../../layers/aws/dynamodb/dynamo-entities/order";
import { sendServerError } from "../../../admin/route-errors";

/*
 * GET /store/messages/image-upload-urls/:storeId/:conversationId/:pngCount/:jpgCount
 * (store members; L.10) → { png: [...], jpg: [...] } presigned POSTs (≤ 5 MB each, 1–4 in all)
 * in the conversation's folder. 404 CONVERSATION_NOT_FOUND (also for an order that isn't this
 * store's or isn't paid).
 */
export default function registerRoute(router: Router): void {
  router.get("/image-upload-urls/:storeId/:conversationId/:pngCount/:jpgCount", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      () => true,
      (req) => {
        const png = parseUploadCount(req.params.pngCount);
        const jpg = parseUploadCount(req.params.jpgCount);
        return isUlid(req.params.conversationId) && png !== null && jpg !== null && png + jpg >= 1 && png + jpg <= MAX_MESSAGE_IMAGES;
      },
      executeRouteCore,
      true,
      storeMember((req) => req.params.storeId)
    );
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  const storeId = String(req.params.storeId);
  const id = String(req.params.conversationId);
  try {
    if (!(await getConversation(storeId, id))) {
      const order = await getOrderById(id);
      if (!order || order.storeId !== storeId || typeof order.storeOrderPaidAt !== "number") {
        res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" });
        return;
      }
    }
    res.send(await createImageUploads(messageImageFolder(storeId, id), parseUploadCount(req.params.pngCount)!, parseUploadCount(req.params.jpgCount)!));
  } catch (e) {
    sendServerError(e, res, "In store/messages/image-upload-urls");
  }
}
