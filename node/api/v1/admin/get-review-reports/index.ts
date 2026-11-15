import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { listReviewReports } from "../../../../layers/aws/dynamodb/dynamo-entities/review";
import { sendServerError } from "../route-errors";

/* GET /admin/get-review-reports (admins; L.7 / 7.5) → { reports }: open reports, oldest first. */
export default function registerRoute(router: Router): void {
  router.get("/get-review-reports", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, () => true, () => true, executeRouteCore, true, /* admins only */ true);
  });
}

async function executeRouteCore(_req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    res.send({ reports: await listReviewReports() });
  } catch (e) {
    sendServerError(e, res, "In get-review-reports");
  }
}
