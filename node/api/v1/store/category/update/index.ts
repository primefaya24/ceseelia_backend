// Imports
import { Request, Response, Router } from "express";
import dotenv from "dotenv";
import { validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { IN_DEV } from "../../../../../config";
import { appConstants } from "../../../../../constants";
dotenv.config();

/*
 * Request/Response interfaces
 */
interface ReqBody {}

interface ResBody {}

/*
 * Module Route
 */
module.exports = function (router: Router): void {
  router.put("/update", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      pureRequestParams,
      validRequestParams,
      executeRouteCore,
      true,
    );
  });
};

function pureRequestParams(req: Request): boolean {
  return (
    typeof req.body.storeName === "string" &&
    typeof req.body.storeSlug === "string"
  );
}

/*
 * Ensure request params are valid
 */
function validRequestParams(req: Request): boolean {
  return req.body.storeName.length > 0 && req.body.storeSlug.length > 0;
}

/*
 * Route controller logic
 */
async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    // Extract params
    // TODO

    // Respond to user
    res.send({});
  } catch (e) {
    if (IN_DEV) {
      console.error(e);
    }
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
