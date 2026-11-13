import { Request, Response, Router } from "express";
import {
  getAuth,
  storeMember,
  validateAndExecuteHttpApiRoute,
} from "../../../../../layers/core/http";
import { readStoreStripeAccount } from "../../../../../layers/payments/account-status";
import { sendPaymentsError } from "../errors";

/*
 * GET /store/payments/status/:storeId (store members, 5.2b)
 * → { canManage, connected: false, disconnected? }
 *   | { canManage, connected: true, chargesEnabled, payoutsEnabled, detailsSubmitted, requirementsDue,
 *       pastDue, pendingVerification, deadline, disabledReason, country, defaultCurrency }
 * requirementsDue: details Stripe needs now (currently_due ∪ past_due); pastDue: those already
 * late (payments or payouts are or will be paused); deadline: when the current ones are due (ms),
 * else when upcoming ones are (future_requirements), else null. pendingVerification: details
 * Stripe is still checking (nothing to do but wait). canManage: this user may connect or update
 * the account (platform admin or store ADMIN), so the webapp doesn't rely on its cached profile.
 * Reads the account from Stripe (the truth) and refreshes the store's cached flags, which the
 * storefront's `paymentsEnabled` comes from. A Standard merchant can disconnect Ceseelia from
 * their Stripe dashboard; then the store forgets the account (`disconnected: true`).
 * 404 STORE_NOT_FOUND · 503 PAYMENTS_NOT_CONFIGURED · 502 STRIPE_ERROR
 */
export default function registerRoute(router: Router): void {
  router.get("/status/:storeId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      () => true,
      () => true,
      executeRouteCore,
      true,
      storeMember((req) => req.params.storeId)
    );
  });
}

export { isAccountGone } from "../../../../../layers/payments/account-status";

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const storeId = req.params.storeId as string;
    const auth = getAuth(res);
    const canManage = auth.isAdmin || auth.storeRole === "ADMIN";
    const read = await readStoreStripeAccount(storeId);
    if (!read.connected) {
      res.send(read.disconnected ? { canManage, connected: false, disconnected: true } : { canManage, connected: false });
      return;
    }
    const { account, chargesEnabled, payoutsEnabled, detailsSubmitted } = read;
    const flags = { chargesEnabled, payoutsEnabled, detailsSubmitted };
    const needs = account.requirements;
    const deadline =
      needs?.current_deadline ?? account.future_requirements?.current_deadline ?? null;
    res.send({
      canManage,
      connected: true,
      ...flags,
      requirementsDue: new Set([...(needs?.currently_due ?? []), ...(needs?.past_due ?? [])]).size,
      pastDue: needs?.past_due?.length ?? 0,
      pendingVerification: needs?.pending_verification?.length ?? 0,
      deadline: deadline ? deadline * 1000 : null,
      disabledReason: needs?.disabled_reason ?? null,
      country: account.country ?? null,
      defaultCurrency: account.default_currency?.toUpperCase() ?? null,
    });
  } catch (e) {
    sendPaymentsError(e, res, "In payments/status");
  }
}
