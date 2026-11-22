// Imports
import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute, storeMember } from "../../../../../layers/core/http";
import { appConstants } from "../../../../../constants";
import { MAX_COUNT, MAX_LENGTH } from "../../../../../constants/input-limits";
import {
  isStoreParamDefPure,
  isStoreParamDefValid,
  StoreParamDef,
} from "../../../../../layers/core/interfaces/store";
import { applyParamDef, cleanParamDef, sameParamKey } from "../../../../../layers/core/store-params";
import { planForStore, writeItemChanges } from "../../../../../layers/core/store-params/fan-out";
import {
  listStoreParams,
  putStoreParam,
  StoreRecordNotFoundError,
} from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { isUlid } from "../../../../../layers/core/utils";
import { log } from "../../../../../layers/core/logger";

/*
 * POST /store/parameter/save {storeId, isUpdate, param, renames?} (Stage R.3b)
 *
 * Creates (`isUpdate` false, a new id) or updates a store parameter, then rewrites every item
 * that uses it (`layers/core/store-params`). `renames` {old option: new option} tells the
 * update which options were renamed, so their rows keep stock and prices.
 * → 200 {param, itemsUpdated, itemsFailed}
 *   409 PARAM_KEY_TAKEN (same name and tag, ignoring case) · PARAM_LIMIT (50 per store)
 *   409 PARAM_BREAKS_ITEMS {items: [{itemId, itemName, problem}]}: nothing saved
 *   404 parameter or store not found
 */
export default function registerRoute(router: Router): void {
  router.post("/save", (req: Request, res: Response): void => {
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

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function pureRequestParams(req: Request): boolean {
  const b = req.body;
  return (
    isUlid(b.storeId) &&
    typeof b.isUpdate === "boolean" &&
    isStoreParamDefPure(b.param) &&
    (b.renames === undefined || (isObject(b.renames) && Object.values(b.renames).every((v) => typeof v === "string")))
  );
}

function validRequestParams(req: Request): boolean {
  const b = req.body;
  req.body.param = cleanParamDef(b.param);
  const renames: Record<string, string> = b.renames ?? {};
  const entries = Object.entries(renames);
  return (
    (b.isUpdate ? isUlid(req.body.param.storeParamId) : true) &&
    isStoreParamDefValid(req.body.param) &&
    entries.length <= MAX_COUNT.paramOptions &&
    entries.every(([k, v]) => k.length <= MAX_LENGTH.paramOption && v.length <= MAX_LENGTH.paramOption)
  );
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const storeId: string = req.body.storeId;
    const isUpdate: boolean = req.body.isUpdate;
    const param: StoreParamDef = req.body.param;
    const renames: Record<string, string> = req.body.renames ?? {};

    const existing = await listStoreParams(storeId);
    if (isUpdate && !existing.some((p) => p.storeParamId === param.storeParamId)) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: "Parameter not found" });
      return;
    }
    const others = existing.filter((p) => !isUpdate || p.storeParamId !== param.storeParamId);
    if (others.some((p) => sameParamKey(p, param))) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({
        code: "PARAM_KEY_TAKEN",
        message: "Another parameter has this name. Add a tag to tell them apart.",
      });
      return;
    }
    if (!isUpdate && existing.length >= MAX_COUNT.storeParams) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({
        code: "PARAM_LIMIT",
        message: `A store can have up to ${MAX_COUNT.storeParams} parameters.`,
      });
      return;
    }

    if (!isUpdate) {
      const saved = await putStoreParam(storeId, param, false);
      res.send({ param: saved, itemsUpdated: 0, itemsFailed: 0 });
      return;
    }

    const change = (item: Parameters<typeof applyParamDef>[0]) => applyParamDef(item, param, renames);
    const plan = await planForStore(storeId, param.storeParamId, change);
    if (plan.problems.length > 0) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({
        code: "PARAM_BREAKS_ITEMS",
        message: "This change doesn't fit some items. Fix them first, or change less at once.",
        items: plan.problems,
      });
      return;
    }
    const saved = await putStoreParam(storeId, param, true);
    const { updated, failed } = await writeItemChanges(storeId, plan, param.storeParamId, change);
    res.send({ param: saved, itemsUpdated: updated, itemsFailed: failed });
  } catch (e) {
    if (e instanceof StoreRecordNotFoundError) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: e.message });
      return;
    }
    log.error({ err: e }, "In store/parameter/save");
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
