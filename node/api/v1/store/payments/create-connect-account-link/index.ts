import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { WEBAPP_URL } from "../../../../../config";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { PAYMENT_COUNTRIES, PaymentCountry } from "../../../../../layers/core/interfaces/store";
import {
  getStorePayments,
  saveStoreStripeAccount,
} from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { StoreRole } from "../../../../../layers/aws/dynamodb/dynamo-entities/membership";
import { getStripe } from "../../../../../layers/payments/stripe";
import { sendPaymentsError } from "../errors";

/*
 * POST /store/payments/create-connect-account-link (store admins, 5.2a)
 * Body: { storeId, country? } → { url, expiresAt }
 * The first call creates the store's Stripe **Standard** account (owned by the merchant) in
 * `country` (CA, US or AU; it can't change later, so it's required until an account exists) and
 * saves its id. Every call returns a fresh one-time onboarding link (Account Links expire within
 * minutes, so the webapp asks for one per click). Stripe sends the merchant back to the
 * storefront editor: `?payments=return` when they leave the flow, `?payments=refresh` when the
 * link expired (ask for a new one). Finishing isn't guaranteed by `return`: read the status.
 * 400 COUNTRY_REQUIRED · 404 STORE_NOT_FOUND · 503 PAYMENTS_NOT_CONFIGURED · 502 STRIPE_ERROR
 */
export default function registerRoute(router: Router): void {
  router.post("/create-connect-account-link", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      pureRequestParams,
      validRequestParams,
      executeRouteCore,
      true,
      storeMember(
        (req) => req.body.storeId,
        appConstants.STORE_MEMBER_PERMISSION_ADMIN as StoreRole
      )
    );
  });
}

function pureRequestParams(req: Request): boolean {
  const { country } = req.body;
  return country === undefined || typeof country === "string";
}

function validRequestParams(req: Request): boolean {
  const { country } = req.body;
  return country === undefined || (PAYMENT_COUNTRIES as readonly string[]).includes(country);
}

export function onboardingReturnUrl(storeId: string, outcome: "return" | "refresh"): string {
  return `${WEBAPP_URL}/store/storefront/${storeId}?payments=${outcome}`;
}

/** How long a Connect account creation key lasts: covers double clicks and quick retries. */
export const ACCOUNT_KEY_WINDOW_MS = 10 * 60 * 1000;

/**
 * The idempotency key for creating a store's Stripe account. A double click (or a retry) in the
 * same 10-minute window gets the same account back; a store that disconnected its old account
 * gets a new key. The window is in the key because Stripe replays the saved response for 24 h,
 * errors included: without it, one refusal (e.g. before the live platform profile was
 * finished, 2026-11-19) came back on every click for a day.
 */
export function accountIdempotencyKey(
  storeId: string,
  disconnectedAt: number | undefined,
  country: string,
  now: number = Date.now()
): string {
  const window = Math.floor(now / ACCOUNT_KEY_WINDOW_MS);
  return `store-${storeId}-account-${disconnectedAt ?? 0}-${country}-${window}`;
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const storeId: string = req.body.storeId;
    const country = req.body.country as PaymentCountry | undefined;
    const payments = await getStorePayments(storeId);
    let accountId = payments.stripeAccountId;
    const stripe = await getStripe();

    if (!accountId) {
      if (!country) {
        res
          .status(appConstants.HTTP_STATUS_CODE_BAD_REQUEST)
          .send({ message: "Choose the country your business is in.", code: "COUNTRY_REQUIRED" });
        return;
      }
      const account = await stripe.accounts.create(
        { type: "standard", country, metadata: { storeId } },
        { idempotencyKey: accountIdempotencyKey(storeId, payments.disconnectedAt, country) }
      );
      accountId = await saveStoreStripeAccount(storeId, account.id);
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      refresh_url: onboardingReturnUrl(storeId, "refresh"),
      return_url: onboardingReturnUrl(storeId, "return"),
    });
    res.send({ url: link.url, expiresAt: link.expires_at });
  } catch (e) {
    sendPaymentsError(e, res, "In create-connect-account-link");
  }
}
