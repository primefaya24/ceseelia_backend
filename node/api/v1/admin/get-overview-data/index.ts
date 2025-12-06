// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { IN_DEV } from "../../../../config";
import { appConstants } from "../../../../constants";
import { AdminOverviewData } from "../../../../layers/core/interfaces/admin";
import { StoreOverview } from "../../../../layers/core/interfaces/store";
import { getAllStores } from "../../../../layers/aws/dynamodb/dynamo-entities/admin";
dotenv.config();

/*
 * Module Route
 */
module.exports = function (router: Router): void {
  router.get("/get-overview-data", (req: Request, res: Response): void => {
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

    // Respond to user
    const overviewData: AdminOverviewData = {
      quickStats: {},
      salesActivity: {},
      joinRequests: {},
      supportTickets: {},
      allStores: allStores,
    };
    res.send(overviewData);
  } catch (e) {
    if (IN_DEV) {
      console.error(e);
    }
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
