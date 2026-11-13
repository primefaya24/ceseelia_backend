import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { MAX_LENGTH } from "../../../../constants/input-limits";
import { isValidSlug } from "../../../../constants/slug";
import { getAuth, validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { createRateLimiter } from "../../../../layers/core/http/rate-limit";
import { MAX_DRAFT_STORES_PER_ACCOUNT } from "../../../../layers/core/plans";
import { createStore, StoreOwnerNotFoundError } from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { countDraftStoresAdministeredBy } from "../../../../layers/aws/dynamodb/dynamo-entities/membership";
import { SlugTakenError } from "../../../../layers/aws/dynamodb/dynamo-entities/slug";
import { findUserIdByCognitoId, UserDeactivatedError } from "../../../../layers/aws/dynamodb/dynamo-entities/user";
import { ACCOUNT_DEACTIVATED, PROFILE_NOT_FOUND } from "../../user/user-errors";

/*
 * POST /merchant/create-store (any signed-in user, progress.md P.3)
 * Body: { storeName, storeSlug } → 200 { storeId, storeName, storeSlug, status: "DRAFT", plan: "FREE" }
 *
 * Self-serve: anyone with an account builds a store without committing. The store is a FREE
 * DRAFT (shoppers see "Coming soon"), and the caller becomes its ADMIN in the same transaction.
 * Nothing is checked about the store's contents here; that happens at Go Live (P.4, including
 * runSmartStoreValidation).
 *
 * - The account must have its user rows (the sign-up Lambda writes them after the email is
 *   confirmed, so an account with rows has a verified email): else 404 PROFILE_NOT_FOUND.
 *   Deactivated: 403 ACCOUNT_DEACTIVATED.
 * - At most MAX_DRAFT_STORES_PER_ACCOUNT (5) drafts the caller is ADMIN of: 409 DRAFT_LIMIT_REACHED.
 * - 5 creates per account per hour: 429 RATE_LIMITED with Retry-After.
 * - Slug already reserved: 409 SLUG_TAKEN. Same name / slug rules as the admin's /store/create.
 */
export const createStoreLimits = {
  perAccount: createRateLimiter({ windowMs: 60 * 60_000, max: 5 }),
};

export default function registerRoute(router: Router): void {
  router.post("/create-store", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore, true, false);
  });
}

function pureRequestParams(req: Request): boolean {
  return typeof req.body.storeName === "string" && typeof req.body.storeSlug === "string";
}

function validRequestParams(req: Request): boolean {
  const name = req.body.storeName.trim();
  return name.length > 0 && name.length <= MAX_LENGTH.storeName && isValidSlug(req.body.storeSlug);
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  const { cognitoId } = getAuth(res);
  try {
    const userId = await findUserIdByCognitoId(cognitoId);
    if (!userId) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: "Profile not found", code: PROFILE_NOT_FOUND });
      return;
    }

    const limited = createStoreLimits.perAccount.take(userId);
    if (!limited.ok) {
      res.setHeader("Retry-After", String(limited.retryAfterSeconds));
      res.status(429).send({ message: "Too many stores created. Please try again later.", code: "RATE_LIMITED" });
      return;
    }

    if ((await countDraftStoresAdministeredBy(userId)) >= MAX_DRAFT_STORES_PER_ACCOUNT) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({
        message: `You can have up to ${MAX_DRAFT_STORES_PER_ACCOUNT} stores that aren't live yet.`,
        code: "DRAFT_LIMIT_REACHED",
        limit: MAX_DRAFT_STORES_PER_ACCOUNT,
      });
      return;
    }

    const storeName = req.body.storeName.trim();
    const overview = await createStore(storeName, req.body.storeSlug, { userId });
    res.send({
      storeId: overview.storeId,
      storeName: overview.storeName,
      storeSlug: overview.storeSlug,
      status: "DRAFT",
      plan: "FREE",
    });
  } catch (e) {
    if (e instanceof SlugTakenError) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ message: e.message, code: "SLUG_TAKEN" });
      return;
    }
    if (e instanceof UserDeactivatedError) {
      res.status(appConstants.HTTP_STATUS_CODE_FORBIDDEN).send({ message: e.message, code: ACCOUNT_DEACTIVATED });
      return;
    }
    if (e instanceof StoreOwnerNotFoundError) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: e.message, code: PROFILE_NOT_FOUND });
      return;
    }
    console.error("In merchant/create-store", e);
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
