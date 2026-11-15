import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { isUlid } from "../../../../layers/core/utils";
import { ReportChangedError, decideReviewReport } from "../../../../layers/aws/dynamodb/dynamo-entities/review";
import { log } from "../../../../layers/core/logger";
import { sendServerError } from "../route-errors";

/*
 * POST /admin/decide-review-report { storeId, orderId, decision: KEEP | REMOVE } (admins; L.7)
 *   → { decision }. KEEP: the review stays and can't be reported again. REMOVE: hidden from the
 *   storefront and out of the rating. 409 REPORT_CHANGED if there's no open report.
 */
export default function registerRoute(router: Router): void {
  router.post("/decide-review-report", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => isUlid(req.body?.storeId) && isUlid(req.body?.orderId) && typeof req.body?.decision === "string",
      (req) => req.body.decision === "KEEP" || req.body.decision === "REMOVE",
      executeRouteCore,
      true,
      /* admins only */ true
    );
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    await decideReviewReport(String(req.body.storeId), String(req.body.orderId), req.body.decision, Date.now());
    log.info({ storeId: req.body.storeId, orderId: req.body.orderId, decision: req.body.decision }, "Review report decided");
    res.send({ decision: req.body.decision });
  } catch (e) {
    if (e instanceof ReportChangedError) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code: "REPORT_CHANGED", message: e.message });
      return;
    }
    sendServerError(e, res, "In decide-review-report");
  }
}
