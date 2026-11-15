import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../../layers/core/http/cache";
import { REVIEW_SK_PATTERN, getReviewStats, listReviews } from "../../../../../layers/aws/dynamodb/dynamo-entities/review";
import { log } from "../../../../../layers/core/logger";

/*
 * GET /store/reviews/list/:storeId?cursor= (store members; L.7 / 7.5) → { stats, reviews, next }
 * Every review, newest first, including removed ones (`status`) and the report's state, so the
 * merchant sees what happened to a review they reported. No shopper contact details.
 */
export default function registerRoute(router: Router): void {
  router.get("/list/:storeId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => req.query.cursor === undefined || typeof req.query.cursor === "string",
      (req) => req.query.cursor === undefined || REVIEW_SK_PATTERN.test(String(req.query.cursor)),
      executeRouteCore,
      true,
      storeMember((req) => req.params.storeId)
    );
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const storeId = String(req.params.storeId);
  const cursor = req.query.cursor as string | undefined;
  try {
    const [page, stats] = await Promise.all([listReviews(storeId, { cursor, publishedOnly: false }), cursor ? null : getReviewStats(storeId)]);
    res.send({
      stats,
      // Who reported it stays between the store and the platform.
      reviews: page.reviews.map(({ report, ...r }) => ({ ...r, report: report ? { reason: report.reason, note: report.note, at: report.at, status: report.status } : null })),
      next: page.next,
    });
  } catch (e) {
    log.error({ err: e }, "In store/reviews/list");
    res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
