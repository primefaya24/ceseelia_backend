import { Response } from "express";
import { getAuth } from "../../../../layers/core/http";
import { findUserIdByCognitoId, getMyProfile } from "../../../../layers/aws/dynamodb/dynamo-entities/user";
import { saveBillingCheckout, StoreBillingState } from "../../../../layers/aws/dynamodb/dynamo-entities/billing";
import {
  BillingNotConfiguredError,
  createPlanCheckout,
  ensureBillingCustomer,
  expirePlanCheckout,
} from "../../../../layers/payments/billing";
import { StorePlan } from "../../../../layers/core/plans";
import { sendPaymentsError } from "../payments/errors";

/* The signed-in user's id (platform admins too: they pay with their own account). */
export async function callerUserId(res: Response): Promise<string | null> {
  const auth = getAuth(res);
  return auth.userId ?? (await findUserIdByCognitoId(auth.cognitoId));
}

/** Reuse a checkout that still has this long to run; otherwise make a new one. */
const REUSE_MIN_MS = 10 * 60 * 1000;

/*
 * A Billing Checkout URL for the store's plan (P.5). The same user asking again for the same
 * plan gets the open one back; anything else closes it and starts a new one, so there's only
 * ever one way to pay for a store at a time.
 */
export async function startPlanCheckout(input: {
  state: StoreBillingState;
  plan: StorePlan;
  currency: "CAD" | "USD" | "AUD";
  userId: string;
}): Promise<string> {
  const { state, plan, currency, userId } = input;
  const open = state.checkout;
  if (open && open.plan === plan && open.userId === userId && open.expiresAt - Date.now() > REUSE_MIN_MS) {
    return open.url;
  }
  if (open) await expirePlanCheckout(open.sessionId);

  const profile = (await getMyProfile(userId))?.info ?? {};
  const name = [profile.userFirstName, profile.userLastName].filter((p) => typeof p === "string" && p).join(" ");
  const customerId = await ensureBillingCustomer(
    { userId, email: typeof profile.userEmailAddress === "string" ? profile.userEmailAddress : "", name },
    currency
  );
  const session = await createPlanCheckout({
    storeId: state.storeId,
    storeName: state.storeName,
    plan,
    currency,
    userId,
    customerId,
  });
  await saveBillingCheckout(state.storeId, { ...session, plan, userId });
  return session.url;
}

/* Payments errors, plus 503 BILLING_NOT_CONFIGURED when a plan's price isn't set up. */
export function sendBillingError(e: unknown, res: Response, where: string): void {
  if (e instanceof BillingNotConfiguredError) {
    console.error(where, e.message);
    res.status(503).send({ code: "BILLING_NOT_CONFIGURED", message: "Paid plans aren't available right now." });
    return;
  }
  sendPaymentsError(e, res, where);
}
