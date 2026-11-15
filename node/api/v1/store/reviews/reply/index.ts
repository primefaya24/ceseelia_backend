import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { MAX_LENGTH } from "../../../../../constants/input-limits";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { isUlid } from "../../../../../layers/core/utils";
import { cleanReviewText, getReviewForOrder, setReviewReply } from "../../../../../layers/aws/dynamodb/dynamo-entities/review";
import { log } from "../../../../../layers/core/logger";

/*
 * PUT /store/reviews/reply { storeId, orderId, text } (store members; L.7 / 7.5)
 *   → { reply | null }. The store's public answer under a review; sending it again replaces it,
 *   an empty text removes it. The review itself never changes. 404 REVIEW_NOT_FOUND (also for a
 *   removed review).
 */
export default function registerRoute(router: Router): void {
  router.put("/reply", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => typeof req.body?.orderId === "string" && typeof req.body?.text === "string",
      (req) => isUlid(req.body.orderId) && req.body.text.length <= MAX_LENGTH.reviewReply + 100,
      executeRouteCore,
      true,
      storeMember((req) => req.body?.storeId)
    );
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  const storeId = String(req.body.storeId);
  const text = cleanReviewText(req.body.text);
  if (text.length > MAX_LENGTH.reviewReply) {
    res.status(appConstants.HTTP_STATUS_CODE_BAD_REQUEST).send({ code: "REPLY_TOO_LONG", message: `At most ${MAX_LENGTH.reviewReply} characters` });
    return;
  }
  try {
    const found = await getReviewForOrder(storeId, String(req.body.orderId));
    const now = Date.now();
    if (!found || !(await setReviewReply(storeId, found.sk, text, now))) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "REVIEW_NOT_FOUND", message: "Review not found" });
      return;
    }
    res.send({ reply: text ? { text, at: now } : null });
  } catch (e) {
    log.error({ err: e }, "In store/reviews/reply");
    res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
