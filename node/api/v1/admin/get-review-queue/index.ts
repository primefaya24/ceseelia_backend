import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { listReviewQueue } from "../../../../layers/aws/dynamodb/dynamo-entities/store-admin";
import { sendServerError } from "../route-errors";

/*
 * GET /admin/get-review-queue (admin, progress.md P.8)
 * → { stores: [{ storeId, storeName, storeSlug, requestedAt, requestedPlan, reasons,
 *     requestedByUserId }] }, oldest first: the stores Go Live sent to IN_REVIEW
 *   (runSmartStoreValidation flagged them, or couldn't run).
 */
export default function registerRoute(router: Router): void {
  router.get("/get-review-queue", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, () => true, () => true, executeRouteCore, true, /* admins only */ true);
  });
}

async function executeRouteCore(_req: Request, res: Response): Promise<void> {
  try {
    res.set("Cache-Control", "no-store").send({ stores: await listReviewQueue() });
  } catch (e) {
    sendServerError(e, res, "In get-review-queue");
  }
}
