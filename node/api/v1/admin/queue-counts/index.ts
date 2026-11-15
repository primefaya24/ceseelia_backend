import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { listReviewQueue } from "../../../../layers/aws/dynamodb/dynamo-entities/store-admin";
import { listItemReviewQueue } from "../../../../layers/aws/dynamodb/dynamo-entities/item-review";
import { listReviewReports } from "../../../../layers/aws/dynamodb/dynamo-entities/review";
import { countOpenTickets } from "../../../../layers/aws/dynamodb/dynamo-entities/support-ticket";
import { log } from "../../../../layers/core/logger";

/*
 * GET /admin/queue-counts (admins; L.9): what's waiting, for the admin menu's badges.
 * → { storeReviews, itemReviews, reviewReports, openTickets }. Four queue reads, no order or
 * store scans; cached 20 s (every admin tab asks once a minute).
 */
let cached: { at: number; body: Record<string, number> } | null = null;
export const resetQueueCountsCacheForTests = () => (cached = null);

export default function registerRoute(router: Router): void {
  router.get("/queue-counts", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, () => true, () => true, executeRouteCore, true, true);
  });
}

async function executeRouteCore(_req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    if (!cached || Date.now() - cached.at > 20_000) {
      const [storeReviews, itemReviews, reviewReports, openTickets] = await Promise.all([
        listReviewQueue(),
        listItemReviewQueue(),
        listReviewReports(),
        countOpenTickets(),
      ]);
      cached = {
        at: Date.now(),
        body: { storeReviews: storeReviews.length, itemReviews: itemReviews.length, reviewReports: reviewReports.length, openTickets },
      };
    }
    res.send(cached.body);
  } catch (e) {
    log.error({ err: e }, "In admin/queue-counts");
    res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
