import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../../layers/core/http/cache";
import { isUlid } from "../../../../../layers/core/utils";
import { getStoreOverviewRow } from "../../../../../layers/aws/dynamodb/dynamo-entities/membership";
import { REVIEW_SK_PATTERN, getReviewStats, listReviews } from "../../../../../layers/aws/dynamodb/dynamo-entities/review";
import { publicReviewView } from "../../../customer/review/index";
import { log } from "../../../../../layers/core/logger";

/*
 * GET /store/public/reviews/:storeId?cursor= (no auth; L.7 / 7.5) → { stats, reviews, next }
 * Published reviews only, newest first, 20 a page, with the store's rating summary (stats on
 * the first page only). 404 STORE_NOT_FOUND.
 */
export default function registerRoute(router: Router): void {
  router.get("/reviews/:storeId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (req) => req.query.cursor === undefined || typeof req.query.cursor === "string",
      (req) => isUlid(req.params.storeId) && (req.query.cursor === undefined || REVIEW_SK_PATTERN.test(String(req.query.cursor))),
      executeRouteCore,
      false
    );
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const storeId = String(req.params.storeId);
  const cursor = req.query.cursor as string | undefined;
  try {
    if (!(await getStoreOverviewRow(storeId))) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "STORE_NOT_FOUND", message: "Store not found" });
      return;
    }
    const [page, stats] = await Promise.all([listReviews(storeId, { cursor, publishedOnly: true }), cursor ? null : getReviewStats(storeId)]);
    res.send({ stats, reviews: page.reviews.map(publicReviewView), next: page.next });
  } catch (e) {
    log.error({ err: e }, "In store/public/reviews");
    res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
