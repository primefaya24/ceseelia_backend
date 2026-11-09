import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { isUlid } from "../../../../layers/core/utils";
import { removeStoreMember } from "../../../../layers/aws/dynamodb/dynamo-entities/membership";
import { sendMembershipError, sendServerError } from "../route-errors";

/*
 * DELETE /admin/remove-store-member/:storeId/:userId (admin, progress.md 1.4d)
 * → { removed: true } · 404 NOT_A_MEMBER
 */
export default function registerRoute(router: Router): void {
  router.delete("/remove-store-member/:storeId/:userId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureRequestParams, () => true, executeRouteCore, true, /* admins only */ true);
  });
}

function pureRequestParams(req: Request): boolean {
  return isUlid(req.params.storeId) && isUlid(req.params.userId);
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    await removeStoreMember(req.params.storeId as string, req.params.userId as string);
    res.send({ removed: true });
  } catch (e) {
    if (!sendMembershipError(e, res)) {
      sendServerError(e, res, "In remove-store-member");
    }
  }
}
