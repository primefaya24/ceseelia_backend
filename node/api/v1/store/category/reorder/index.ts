/*
 * POST /store/category/reorder { storeId, categoryIds }  (owner, 2026-11-23)
 *
 * The merchant dragged the categories into a new order: `categoryIds` lists every category of the
 * store once, first shown first. Store members (like saving a category). 409 CATEGORIES_CHANGED
 * when the list doesn't match the store's categories (one added or deleted meanwhile).
 */
import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute, storeMember } from "../../../../../layers/core/http";
import { appConstants } from "../../../../../constants";
import {
  CategoriesChangedError,
  reorderStoreCategories,
} from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { isUlid } from "../../../../../layers/core/utils";
import { log } from "../../../../../layers/core/logger";

/** More than any store has; keeps a request small. */
export const MAX_REORDER_CATEGORIES = 500;

export default function registerRoute(router: Router): void {
  router.post("/reorder", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      pureRequestParams,
      validRequestParams,
      executeRouteCore,
      true,
      storeMember((req) => req.body.storeId)
    );
  });
}

function pureRequestParams(req: Request): boolean {
  const ids = req.body?.categoryIds;
  return isUlid(req.body?.storeId) && Array.isArray(ids) && ids.every((id: unknown) => isUlid(id));
}

function validRequestParams(req: Request): boolean {
  const ids: string[] = req.body.categoryIds;
  return ids.length > 0 && ids.length <= MAX_REORDER_CATEGORIES && new Set(ids).size === ids.length;
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    await reorderStoreCategories(req.body.storeId, req.body.categoryIds);
    res.send({ ok: true });
  } catch (e) {
    if (e instanceof CategoriesChangedError) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code: "CATEGORIES_CHANGED", message: e.message });
      return;
    }
    log.error({ err: e }, "In store/category/reorder");
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
