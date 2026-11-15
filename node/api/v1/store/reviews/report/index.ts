import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { MAX_LENGTH } from "../../../../../constants/input-limits";
import { getAuth, storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { isUlid } from "../../../../../layers/core/utils";
import { getStoreOverviewRow } from "../../../../../layers/aws/dynamodb/dynamo-entities/membership";
import {
  REPORT_REASONS,
  ReportReason,
  ReportRefusedError,
  cleanReviewText,
  getReviewForOrder,
  reportReview,
} from "../../../../../layers/aws/dynamodb/dynamo-entities/review";
import { notifyReviewReported } from "../../../../../layers/notifications/admin-alerts";
import { log } from "../../../../../layers/core/logger";

/*
 * POST /store/reviews/report { storeId, orderId, reason, note } (store members; L.7 / 7.5)
 *   → { report }. Asks Ceseelia to look at a review (OFFENSIVE, PERSONAL_INFO, SPAM, OTHER; a
 *   note is required for OTHER). The review stays live until a platform admin decides; once per
 *   review (409 ALREADY_REPORTED, also after a KEEP). Emails ADMIN_ALERT_EMAIL. 404 REVIEW_NOT_FOUND.
 */
export default function registerRoute(router: Router): void {
  router.post("/report", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => typeof req.body?.orderId === "string" && typeof req.body?.reason === "string" && (req.body?.note === undefined || typeof req.body.note === "string"),
      (req) =>
        isUlid(req.body.orderId) &&
        (REPORT_REASONS as readonly string[]).includes(req.body.reason) &&
        (req.body.note ?? "").length <= MAX_LENGTH.reviewReportNote + 100,
      executeRouteCore,
      true,
      storeMember((req) => req.body?.storeId)
    );
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  const storeId = String(req.body.storeId);
  const reason = req.body.reason as ReportReason;
  const note = cleanReviewText(String(req.body.note ?? "")).slice(0, MAX_LENGTH.reviewReportNote);
  if (reason === "OTHER" && !note) {
    res.status(appConstants.HTTP_STATUS_CODE_BAD_REQUEST).send({ code: "NOTE_REQUIRED", message: "Tell us what's wrong with this review" });
    return;
  }
  try {
    const found = await getReviewForOrder(storeId, String(req.body.orderId));
    if (!found || found.review.status !== "PUBLISHED") {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "REVIEW_NOT_FOUND", message: "Review not found" });
      return;
    }
    if (found.review.report) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code: "ALREADY_REPORTED", message: "This review has already been reported" });
      return;
    }
    const auth = getAuth(res);
    const storeName = String((await getStoreOverviewRow(storeId))?.storeName ?? "");
    const report = await reportReview(found.review, found.sk, { reason, note, byUserId: auth.userId ?? `admin:${auth.cognitoId}` }, storeName, Date.now());
    await notifyReviewReported(storeId, storeName, found.review.rating, reason);
    res.send({ report: { reason: report.reason, note: report.note, at: report.at, status: report.status } });
  } catch (e) {
    if (e instanceof ReportRefusedError) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code: "ALREADY_REPORTED", message: e.message });
      return;
    }
    log.error({ err: e }, "In store/reviews/report");
    res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
