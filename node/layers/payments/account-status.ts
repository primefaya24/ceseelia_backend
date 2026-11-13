import Stripe from "stripe";
import {
  clearStoreStripeAccount,
  getStorePayments,
  updateStorePaymentsStatus,
} from "../aws/dynamodb/dynamo-entities/store";
import { getStripe } from "./stripe";

export type StoreStripeAccount =
  | { connected: false; disconnected: boolean }
  | {
      connected: true;
      account: Stripe.Account;
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
      detailsSubmitted: boolean;
    };

/* Stripe's answer when the platform no longer has access to the account. */
export function isAccountGone(e: unknown): boolean {
  if (e instanceof Stripe.errors.StripePermissionError) return true;
  if (e instanceof Stripe.errors.StripeInvalidRequestError) {
    return e.code === "account_invalid" || e.code === "resource_missing";
  }
  return false;
}

/*
 * The store's Stripe account read live from Stripe (the truth), refreshing the cached flags the
 * storefront's `paymentsEnabled` comes from (5.2b). A Standard merchant can disconnect Ceseelia
 * from their dashboard: then the store forgets the account (`disconnected: true`).
 * Used by payments/status and Go Live (P.4). Throws StoreRecordNotFoundError, Stripe errors and
 * PaymentsNotConfiguredError.
 */
export async function readStoreStripeAccount(storeId: string): Promise<StoreStripeAccount> {
  const payments = await getStorePayments(storeId);
  const accountId = payments.stripeAccountId;
  if (!accountId) return { connected: false, disconnected: false };
  const stripe = await getStripe();
  let account: Stripe.Account;
  try {
    account = await stripe.accounts.retrieve(accountId);
  } catch (e) {
    if (!isAccountGone(e)) throw e;
    await clearStoreStripeAccount(storeId, accountId);
    return { connected: false, disconnected: true };
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
  return { connected: true, account, ...flags };
}
