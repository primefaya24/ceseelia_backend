import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { listItemReviewQueue } from "../../../../layers/aws/dynamodb/dynamo-entities/item-review";
import { sendServerError } from "../route-errors";

/*
 * GET /admin/get-item-review-queue (admin, progress.md L.2)
 * → { items: [{ storeId, itemId, storeName, itemName, imageUri, reasons, flaggedAt }] }, oldest
 *   first: items of live stores the AI check hid from shoppers, waiting for a decision.
 */
export default function registerRoute(router: Router): void {
  router.get("/get-item-review-queue", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, () => true, () => true, executeRouteCore, true, /* admins only */ true);
  });
}

async function executeRouteCore(_req: Request, res: Response): Promise<void> {
  try {
    res.set("Cache-Control", "no-store").send({ items: await listItemReviewQueue() });
  } catch (e) {
    sendServerError(e, res, "In get-item-review-queue");
  }
}
