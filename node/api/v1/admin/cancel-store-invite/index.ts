import { Request, Response, Router } from "express";
import { MAX_LENGTH } from "../../../../constants/input-limits";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { isUlid } from "../../../../layers/core/utils";
import { isEmailOrEmpty } from "../../../../layers/core/utils/validation";
import { cancelStoreInvite } from "../../../../layers/aws/dynamodb/dynamo-entities/membership";
import { sendMembershipError, sendServerError } from "../route-errors";

/*
 * DELETE /admin/cancel-store-invite/:storeId/:email (admin, progress.md 1.4). Email URL-encoded.
 * → { cancelled: true } · 404 NOT_INVITED
 */
export default function registerRoute(router: Router): void {
  router.delete("/cancel-store-invite/:storeId/:email", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore, true, /* admins only */ true);
  });
}

function pureRequestParams(req: Request): boolean {
  return isUlid(req.params.storeId) && typeof req.params.email === "string";
}

function validRequestParams(req: Request): boolean {
  const email = (req.params.email as string).trim();
  return email.length > 0 && email.length <= MAX_LENGTH.email && isEmailOrEmpty(email);
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    await cancelStoreInvite(req.params.storeId as string, req.params.email as string);
    res.send({ cancelled: true });
  } catch (e) {
    if (!sendMembershipError(e, res)) {
      sendServerError(e, res, "In cancel-store-invite");
    }
  }
}
