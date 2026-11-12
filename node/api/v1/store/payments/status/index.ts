import { Request, Response, Router } from "express";
import Stripe from "stripe";
import {
  getAuth,
  storeMember,
  validateAndExecuteHttpApiRoute,
} from "../../../../../layers/core/http";
import {
  clearStoreStripeAccount,
  getStorePayments,
  updateStorePaymentsStatus,
} from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { getStripe } from "../../../../../layers/payments/stripe";
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

/* Stripe's answer when the platform no longer has access to the account. */
export function isAccountGone(e: unknown): boolean {
  if (e instanceof Stripe.errors.StripePermissionError) return true;
  if (e instanceof Stripe.errors.StripeInvalidRequestError) {
    return e.code === "account_invalid" || e.code === "resource_missing";
  }
  return false;
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const storeId = req.params.storeId as string;
    const auth = getAuth(res);
    const canManage = auth.isAdmin || auth.storeRole === "ADMIN";
    const payments = await getStorePayments(storeId);
    const accountId = payments.stripeAccountId;
    if (!accountId) {
      res.send({ canManage, connected: false });
      return;
    }
    const stripe = await getStripe();
    let account: Stripe.Account;
    try {
      account = await stripe.accounts.retrieve(accountId);
    } catch (e) {
      if (!isAccountGone(e)) throw e;
      await clearStoreStripeAccount(storeId, accountId);
      res.send({ canManage, connected: false, disconnected: true });
      return;
    }
    const flags = {
      chargesEnabled: account.charges_enabled === true,
      payoutsEnabled: account.payouts_enabled === true,
      detailsSubmitted: account.details_submitted === true,
    };
    if (
      flags.chargesEnabled !== payments.chargesEnabled ||
      flags.payoutsEnabled !== payments.payoutsEnabled ||
      flags.detailsSubmitted !== payments.detailsSubmitted
    ) {
      await updateStorePaymentsStatus(storeId, accountId, flags);
    }
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
