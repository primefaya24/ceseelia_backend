import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { MAX_LENGTH } from "../../../../constants/input-limits";
import { isValidSlug } from "../../../../constants/slug";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { createRateLimiter } from "../../../../layers/core/http/rate-limit";
import { isUlid } from "../../../../layers/core/utils";
import { updateStoreInfo } from "../../../../layers/aws/dynamodb/dynamo-entities/admin";
import { SlugTakenError } from "../../../../layers/aws/dynamodb/dynamo-entities/slug";
import { StoreRecordNotFoundError } from "../../../../layers/aws/dynamodb/dynamo-entities/store";

/*
 * POST /store/update-info (store ADMIN or platform admin, progress.md P.11)
 * Body: { storeId, storeName, storeSlug } → 200 { storeId, storeName, storeSlug }
 *
 * The store's own admins change its name and link (the platform admin's
 * /admin/update-store-info does the same). The name is set on the overview (Profile, Merchant,
 * Admin lists) and on the storefront (storeInfo.storeName) together.
 *
 * Changing the link releases the old one at once: old links and QR codes stop working and anyone
 * may take the old slug (owner, 2026-11-13). The webapp warns before saving.
 *
 * - 409 SLUG_TAKEN when another store holds the slug. 404 STORE_NOT_FOUND.
 * - 10 saves per store per hour (429 RATE_LIMITED): a link shouldn't churn, and every change
 *   frees a slug for others.
 */
export const updateInfoLimits = {
  perStore: createRateLimiter({ windowMs: 60 * 60_000, max: 10 }),
};

export default function registerRoute(router: Router): void {
  router.post("/update-info", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      pureRequestParams,
      validRequestParams,
      executeRouteCore,
      true,
      storeMember((req) => req.body.storeId, "ADMIN")
    );
  });
}

function pureRequestParams(req: Request): boolean {
  return (
    isUlid(req.body.storeId) && typeof req.body.storeName === "string" && typeof req.body.storeSlug === "string"
  );
}

function validRequestParams(req: Request): boolean {
  const name = req.body.storeName.trim();
  return name.length > 0 && name.length <= MAX_LENGTH.storeName && isValidSlug(req.body.storeSlug);
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  const storeId: string = req.body.storeId;
  const limited = updateInfoLimits.perStore.take(storeId);
  if (!limited.ok) {
    res.setHeader("Retry-After", String(limited.retryAfterSeconds));
    res.status(429).send({ message: "Too many changes. Please try again later.", code: "RATE_LIMITED" });
    return;
  }
  try {
    const overview = await updateStoreInfo(storeId, req.body.storeName.trim(), req.body.storeSlug);
    res.send({ storeId, storeName: overview.storeName, storeSlug: overview.storeSlug });
  } catch (e) {
    if (e instanceof SlugTakenError) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ message: e.message, code: "SLUG_TAKEN" });
      return;
    }
    if (e instanceof StoreRecordNotFoundError) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: "Store not found", code: "STORE_NOT_FOUND" });
      return;
    }
    console.error("In store/update-info", e);
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
