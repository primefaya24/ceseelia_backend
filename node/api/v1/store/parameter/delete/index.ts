// Imports
import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute, storeMember } from "../../../../../layers/core/http";
import { appConstants } from "../../../../../constants";
import { removeParamFromItem } from "../../../../../layers/core/store-params";
import { planForStore, writeItemChanges } from "../../../../../layers/core/store-params/fan-out";
import { deleteStoreParam } from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { isUlid } from "../../../../../layers/core/utils";
import { log } from "../../../../../layers/core/logger";

/*
 * DELETE /store/parameter/delete/:storeId/:paramId (Stage R.3c, R.0d)
 *
 * Takes the parameter off every item that uses it (rows that only differed by it merge), then
 * deletes it. Items first, so a failure leaves the parameter in place to try again. Past orders
 * keep their labels (they store text).
 * → 200 {itemsUpdated, itemsFailed} · 409 PARAM_BREAKS_ITEMS (nothing changed)
 */
export default function registerRoute(router: Router): void {
  router.delete("/delete/:storeId/:paramId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      pureRequestParams,
      () => true,
      executeRouteCore,
      true,
      storeMember((req) => req.params.storeId)
    );
  });
}

function pureRequestParams(req: Request): boolean {
  return isUlid(req.params.storeId) && isUlid(req.params.paramId);
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const storeId = req.params.storeId as string;
    const paramId = req.params.paramId as string;
    const change = (item: Parameters<typeof removeParamFromItem>[0]) => removeParamFromItem(item, paramId);
    const plan = await planForStore(storeId, paramId, change);
    if (plan.problems.length > 0) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({
        code: "PARAM_BREAKS_ITEMS",
        message: "Removing this parameter doesn't fit some items. Fix them first.",
        items: plan.problems,
      });
      return;
    }
    const { updated, failed } = await writeItemChanges(storeId, plan, paramId, change);
    if (failed === 0) await deleteStoreParam(storeId, paramId);
    res.send({ itemsUpdated: updated, itemsFailed: failed });
  } catch (e) {
    log.error({ err: e }, "In store/parameter/delete");
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
