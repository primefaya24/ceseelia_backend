import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { isUlid } from "../../../../layers/core/utils";
import { decideItemReview, ItemReviewChangedError } from "../../../../layers/aws/dynamodb/dynamo-entities/item-review";
import { sendServerError } from "../route-errors";

/*
 * POST /admin/review-item { storeId, itemId, decision: "APPROVE" | "REJECT" } (admin, L.2)
 * APPROVE: the item is shown to shoppers again (and stays approved until the merchant changes
 * it and the check flags it again). REJECT: it stays hidden; the merchant sees "Hidden: doesn't
 * meet Ceseelia's policies" in their inventory.
 * → { status: "APPROVED" | "REJECTED" } · 409 REVIEW_CHANGED (decided meanwhile, or the item is gone)
 */
export default function registerRoute(router: Router): void {
  router.post("/review-item", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore, true, /* admins only */ true);
  });
}

function pureRequestParams(req: Request): boolean {
  const { storeId, itemId, decision } = req.body;
  return isUlid(storeId) && isUlid(itemId) && typeof decision === "string";
}

function validRequestParams(req: Request): boolean {
  return req.body.decision === "APPROVE" || req.body.decision === "REJECT";
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const status = req.body.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    await decideItemReview(String(req.body.storeId), String(req.body.itemId), status);
    res.send({ status });
  } catch (e) {
    if (e instanceof ItemReviewChangedError) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code: "REVIEW_CHANGED", message: e.message });
      return;
    }
    sendServerError(e, res, "In review-item");
  }
}
