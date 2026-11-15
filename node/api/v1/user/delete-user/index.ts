import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { getAuth, validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { createRateLimiter } from "../../../../layers/core/http/rate-limit";
import { log } from "../../../../layers/core/logger";
import { deleteUser } from "../../../../layers/aws/cognito";
import {
  deleteUserRows,
  fetchUserCognitoItems,
  fetchUserUUID,
} from "../../../../layers/aws/dynamodb/dynamo-entities/user";
import {
  getStoreOverviewRow,
  listStoreMemberIds,
  removeStoreMember,
  userStoreIds,
} from "../../../../layers/aws/dynamodb/dynamo-entities/membership";
import { deleteUserTickets } from "../../../../layers/aws/dynamodb/dynamo-entities/support-ticket";
import { sendUserLookupError } from "../user-errors";

/*
 * DELETE /user/delete-user  { confirm: "DELETE" }  (any signed-in user; L.9, was S.11's 501)
 *
 * Deletes the account and everything that is only theirs:
 *   1. refuses an admin account (403 ADMIN_ACCOUNT: removed by hand in Cognito, so the console
 *      can never lose its last admin by a click), and anyone who is the only member of a store
 *      (409 ONLY_MEMBER: the store would be left with nobody; they ask support to close it);
 *   2. leaves their store (other members keep it), deletes their support tickets and messages;
 *   3. deletes their Cognito logins (every sign-in method);
 *   4. deletes every USER# row last.
 * Logins go before the rows so a failure part way can be retried: the rows still say which
 * logins to remove, and a login that's already gone counts as done. 3 tries an hour.
 * Orders, reviews and rewards belong to stores and shoppers, not the account, and stay.
 */
export const CONFIRM_WORD = "DELETE";
export const deleteAccountLimit = createRateLimiter({ windowMs: 3600_000, max: 3 });

export default function registerRoute(router: Router): void {
  router.delete("/delete-user", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (r) => typeof r.body === "object" && r.body !== null && typeof r.body.confirm === "string",
      (r) => r.body.confirm === CONFIRM_WORD,
      executeRouteCore
    );
  });
}

async function executeRouteCore(_req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const auth = getAuth(res);
  try {
    if (auth.isAdmin) {
      res.status(appConstants.HTTP_STATUS_CODE_FORBIDDEN).send({
        code: "ADMIN_ACCOUNT",
        message: "Admin accounts can't be deleted here. Remove the admin role first.",
      });
      return;
    }
    const limit = deleteAccountLimit.take(auth.cognitoId);
    if (!limit.ok) {
      res.set("Retry-After", String(limit.retryAfterSeconds));
      res.status(429).send({ code: "TOO_MANY", message: "Too many tries. Please wait an hour." });
      return;
    }
    const userId: string = await fetchUserUUID(auth.cognitoId);

    const storeIds = await userStoreIds(userId);
    for (const storeId of storeIds) {
      const members = await listStoreMemberIds(storeId);
      if (members.every((m) => m === userId)) {
        const row = await getStoreOverviewRow(storeId);
        res.status(409).send({
          code: "ONLY_MEMBER",
          storeName: row?.storeName ?? null,
          message: "You're the only member of your store. Add another member, or ask support to close the store, before deleting your account.",
        });
        return;
      }
    }

    const logins = (await fetchUserCognitoItems(userId)) ?? [];
    for (const storeId of storeIds) {
      try {
        await removeStoreMember(storeId, userId);
      } catch (e) {
        if ((e as { reason?: string })?.reason !== "NOT_A_MEMBER") throw e;
      }
    }
    const tickets = await deleteUserTickets(userId);
    await deleteUser(logins);
    const rows = await deleteUserRows(userId);
    log.info({ userId, stores: storeIds.length, tickets, rows, logins: logins.length }, "Account deleted");
    res.send({ deleted: true });
  } catch (e) {
    if (sendUserLookupError(e, res)) return;
    log.error({ err: e }, "In user/delete-user");
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
