// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { IN_DEV } from "../../../../config";
import { appConstants } from "../../../../constants";
import { StoreOverview } from "../../../../layers/core/interfaces/store";
import { getAllStores } from "../../../../layers/aws/dynamodb/dynamo-entities/admin";
import { getStoreSummaries } from "../../../../layers/aws/dynamodb/dynamo-entities/store-admin";
dotenv.config();

/*
 * Module Route
 */
export default function registerRoute(router: Router): void {
  router.get("/get-all-stores", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      pureRequestParams,
      validRequestParams,
      executeRouteCore,
      true,
      true
    );
  });
};

function pureRequestParams(req: Request): boolean {
  return true;
}

/*
 * Ensure request params are valid
 */
function validRequestParams(req: Request): boolean {
  return true;
}

/*
 * Route controller logic
 */
async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    // Fetch data
    const allStores: StoreOverview[] = await getAllStores();

    // P.8: each store's status, plan and subscription from its SETTINGS row. A store without
    // one (being deleted) keeps its overview fields only.
    // (Reads every SETTINGS row in full; fine at today's store count, page it when that grows.)
    const summaries = await getStoreSummaries(allStores.map((s) => String(s.storeId)));
    res.send(allStores.map((s) => ({ ...s, ...(summaries[String(s.storeId)] ?? {}) })));
  } catch (e) {
    if (IN_DEV) {
      console.error(e);
    }
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
