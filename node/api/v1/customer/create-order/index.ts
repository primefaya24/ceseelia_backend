import { Request, Response, Router } from "express";
import Stripe from "stripe";
import * as ULID from "ulid";
import { appConstants } from "../../../../constants";
import { MAX_LENGTH } from "../../../../constants/input-limits";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { sendPublicError } from "../../../../layers/core/http/public-storefront";
import { createRateLimiter } from "../../../../layers/core/http/rate-limit";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { Fulfilment, priceLines, Quote, QuoteLineInput } from "../../../../layers/core/pricing";
import { getClientIp, isUlid } from "../../../../layers/core/utils";
import { isEmailOrEmpty, isPhoneOrEmpty } from "../../../../layers/core/utils/validation";
import {
  commissionInEffect,
  feeFromCommission,
  fulfilmentSettings,
  normalizeStoreLifecycle,
  StoreOrder,
  StoreOrderAddress,
} from "../../../../layers/core/interfaces/store";
import {
  getPublicStoreSettings,
  getStoreInventoryData,
  toPublicInventory,
} from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { getStoreOverviewRow } from "../../../../layers/aws/dynamodb/dynamo-entities/membership";
import { createOrderRecords, newOrderCode, newStatusToken } from "../../../../layers/aws/dynamodb/dynamo-entities/order";
import {
  createOrderCheckout,
  expireOrderCheckout,
  MIN_CHARGE_MINOR,
  orderSessionParams,
} from "../../../../layers/payments/order-checkout";
import { PaymentsNotConfiguredError } from "../../../../layers/payments/stripe";
import { cartLinesWithinLimits, isLinePure } from "../quote";

/*
 * POST /customer/create-order (public, guest checkout; progress.md 5.4)
 * Body {
 *   storeId, currency, fulfilment: "PICKUP" | "DELIVERY",
 *   lines: [{ itemId, quantity, params? }],          // as for /customer/quote
 *   expectedTotalMinor,                               // the total the shopper was shown
 *   customer: { name, email, phone? },
 *   address?: { line1, line2?, city, region, postalCode, country },   // DELIVERY only
 *   note?
 * }
 * → 200 { orderId, orderCode, checkoutUrl, statusToken, totalMinor, currency }
 *
 * The server prices the cart again (`priceLines`, 4.2) and never trusts the client's numbers. A
 * delivery is taxed on its own postal code (QA Q.23), never on the geo-IP estimate; pickup on the
 * store's province. Then it opens a Checkout Session on the store's connected account (direct
 * charge, fee from the merchant: `layers/payments/order-checkout`) and saves the order as
 * PENDING_PAYMENT with the session id. The webhook (5.5) takes it from there.
 * `statusToken` is returned once (the order keeps its hash): the shopper's browser keeps it to
 * follow the order (6.4).
 *
 *   - 409 PAYMENTS_UNAVAILABLE: the store can't take payments (no Stripe account or charges off).
 *   - 409 CART_INVALID { quote }: a line can't be bought, or the fulfilment / currency / postal
 *     code isn't accepted (the quote says what).
 *   - 409 PRICE_CHANGED { quote }: the server's total differs from `expectedTotalMinor`; the
 *     shopper sees the new total before paying.
 *   - 409 BELOW_MINIMUM: Stripe can't charge under 0.50.
 *   - 404 STORE_NOT_FOUND / STORE_UNAVAILABLE / STORE_NOT_LIVE. 400 malformed.
 *   - 503 PAYMENTS_NOT_CONFIGURED · 502 STRIPE_ERROR. 10 orders per IP per 10 minutes → 429.
 */
export const createOrderLimit = createRateLimiter({ windowMs: 10 * 60_000, max: 10 });

export const DELIVERY_COUNTRIES = ["CA", "US", "AU"] as const;

export default function registerRoute(router: Router): void {
  router.post("/create-order", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore, false);
  });
}

const isString = (v: unknown): v is string => typeof v === "string";
const isOptString = (v: unknown) => v === undefined || typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function pureRequestParams(req: Request): boolean {
  const b = req.body;
  const c = b?.customer;
  const a = b?.address;
  return (
    isString(b?.storeId) &&
    isString(b?.currency) &&
    (b.fulfilment === "PICKUP" || b.fulfilment === "DELIVERY") &&
    Array.isArray(b.lines) &&
    b.lines.every(isLinePure) &&
    Number.isInteger(b.expectedTotalMinor) &&
    isObj(c) &&
    isString(c.name) &&
    isString(c.email) &&
    isOptString(c.phone) &&
    isOptString(b.note) &&
    (a === undefined ||
      a === null ||
      (isObj(a) &&
        isString(a.line1) &&
        isOptString(a.line2) &&
        isString(a.city) &&
        isString(a.region) &&
        isString(a.postalCode) &&
        isString(a.country)))
  );
}

const within = (v: string, max: number, required = true) => {
  const t = v.trim();
  return t.length <= max && (!required || t.length > 0);
};

function validRequestParams(req: Request): boolean {
  const b = req.body;
  const c = b.customer;
  const lines = b.lines as QuoteLineInput[];
  if (!isUlid(b.storeId) || b.currency.length > 3 || lines.length === 0 || !cartLinesWithinLimits(lines)) return false;
  if (!within(c.name, MAX_LENGTH.personName * 2) || !within(c.email, MAX_LENGTH.email) || !isEmailOrEmpty(c.email)) return false;
  if (c.phone !== undefined && (!within(c.phone, MAX_LENGTH.phone, false) || !isPhoneOrEmpty(c.phone))) return false;
  if (b.note !== undefined && !within(b.note, MAX_LENGTH.orderNote, false)) return false;
  if (b.fulfilment === "PICKUP") return b.address === undefined || b.address === null;
  const a = b.address;
  return (
    isObj(a) &&
    within(a.line1 as string, MAX_LENGTH.addressLine) &&
    (a.line2 === undefined || within(a.line2 as string, MAX_LENGTH.addressLine, false)) &&
    within(a.city as string, MAX_LENGTH.city) &&
    within(a.region as string, MAX_LENGTH.region) &&
    within(a.postalCode as string, MAX_LENGTH.postalCode) &&
    (DELIVERY_COUNTRIES as readonly string[]).includes(a.country as string)
  );
}

function cleanAddress(a: Record<string, string>): StoreOrderAddress {
  return {
    line1: a.line1.trim(),
    line2: (a.line2 ?? "").trim(),
    city: a.city.trim(),
    region: a.region.trim(),
    postalCode: a.postalCode.trim().toUpperCase(),
    country: a.country,
  };
}

const conflict = (res: Response, code: string, message: string, extra: object = {}) =>
  res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code, message, ...extra });

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const ip = getClientIp(req);
  const limited = createOrderLimit.take(`ip:${ip ?? "unknown"}`);
  if (!limited.ok) {
    res.set("Retry-After", String(limited.retryAfterSeconds));
    res.status(429).send({ code: "RATE_LIMITED", message: "Too many orders. Please try again shortly." });
    return;
  }
  const storeId: string = req.body.storeId;
  const fulfilment = req.body.fulfilment as Fulfilment;
  const address = fulfilment === "DELIVERY" ? cleanAddress(req.body.address) : null;

  let stripeAccount = "";
  let sessionId = "";
  try {
    // Live, not suspended (throws the storefront's 404s), then the full data for pricing.
    await getPublicStoreSettings(storeId);
    const raw = await getStoreInventoryData(storeId);
    const payments = raw.settings.payments;
    if (!payments?.stripeAccountId || payments.chargesEnabled !== true) {
      conflict(res, "PAYMENTS_UNAVAILABLE", "This store can't take payments right now.");
      return;
    }
    stripeAccount = payments.stripeAccountId;

    // A Canada-taxed store delivers in Canada: its postal code says the province (4.4).
    if (address && fulfilmentSettings(raw.settings.general).taxMode === "CANADA" && address.country !== "CA") {
      conflict(res, "DELIVERY_COUNTRY", "This store delivers in Canada only.");
      return;
    }

    const quote: Quote = priceLines(
      toPublicInventory(raw),
      (req.body.lines as QuoteLineInput[]).map((l) => ({ itemId: l.itemId, quantity: l.quantity, params: l.params ?? [] })),
      String(req.body.currency).toUpperCase(),
      { fulfilment, ...(address ? { postalCode: address.postalCode } : {}) }
    );
    if (!quote.ok || quote.error || quote.fulfilment !== fulfilment) {
      conflict(res, "CART_INVALID", quote.error?.message ?? "Some items in your cart can't be ordered.", { quote });
      return;
    }
    if (quote.totalMinor !== req.body.expectedTotalMinor) {
      conflict(res, "PRICE_CHANGED", "The total has changed. Please check it before paying.", { quote });
      return;
    }
    if (quote.totalMinor < MIN_CHARGE_MINOR) {
      conflict(res, "BELOW_MINIMUM", "The order total is too small to pay online.");
      return;
    }

    // The commission in effect now is copied onto the order (P.6 / 5.1b).
    const lifecycle = normalizeStoreLifecycle(raw.settings.lifecycle);
    const commission = commissionInEffect(raw.settings.admin, lifecycle.plan);
    const feeMinor = feeFromCommission(commission, quote);
    const overview = await getStoreOverviewRow(storeId);
    const storeSlug = String(overview?.storeSlug ?? "");

    const orderId = ULID.ulid();
    const now = Date.now();
    const email = req.body.customer.email.trim();
    const checkout = await createOrderCheckout(
      orderSessionParams({ orderId, storeId, storeSlug, quote, feeMinor, customerEmail: email, now }),
      stripeAccount,
      orderId
    );
    sessionId = checkout.sessionId;

    const { token, hash } = newStatusToken();
    const order: StoreOrder = {
      storeOrderId: orderId,
      storeId,
      storeOrderCode: newOrderCode(),
      storeOrderStatus: "PENDING_PAYMENT",
      storeOrderType: fulfilment,
      storeOrderCurrency: quote.currency,
      storeOrderCustomer: {
        name: req.body.customer.name.trim(),
        email,
        phone: (req.body.customer.phone ?? "").trim(),
      },
      storeOrderAddress: address,
      storeOrderNote: (req.body.note ?? "").trim(),
      storeOrderLines: quote.lines.map((l) => ({
        itemId: l.itemId,
        itemName: l.itemName,
        quantity: l.quantity,
        params: l.params,
        unitPriceMinor: l.unitPriceMinor,
        discountPercent: l.discountPercent,
        subtotalMinor: l.subtotalMinor,
        discountMinor: l.discountMinor,
        totalMinor: l.totalMinor,
      })),
      storeOrderSubtotalMinor: quote.subtotalMinor,
      storeOrderDiscountMinor: quote.discountMinor,
      storeOrderDeliveryMinor: quote.deliveryMinor,
      storeOrderTaxMinor: quote.taxMinor,
      storeOrderTaxLines: quote.taxLines,
      storeOrderTaxRegion: quote.taxRegion,
      storeOrderPricesIncludeTax: quote.pricesIncludeTax,
      storeOrderTotalMinor: quote.totalMinor,
      storeOrderCommission: commission,
      storeOrderPlatformFeeMinor: feeMinor,
      storeOrderStripe: { accountId: stripeAccount, checkoutSessionId: sessionId, paymentIntentId: "" },
      storeOrderStatusTokenHash: hash,
      storeOrderCreatedAt: now,
      storeOrderUpdatedAt: now,
    };
    await createOrderRecords(order);

    res.send({
      orderId,
      orderCode: order.storeOrderCode,
      checkoutUrl: checkout.url,
      statusToken: token,
      totalMinor: quote.totalMinor,
      currency: quote.currency,
    });
  } catch (e) {
    // A session whose order wasn't saved mustn't be payable.
    if (sessionId) await expireOrderCheckout(sessionId, stripeAccount);
    if (e instanceof PaymentsNotConfiguredError) {
      console.error("In customer/create-order", e.message);
      res.status(503).send({ code: "PAYMENTS_NOT_CONFIGURED", message: "Payments aren't available right now." });
      return;
    }
    if (e instanceof Stripe.errors.StripeError) {
      console.error("In customer/create-order", `${e.type} ${e.code ?? ""} ${e.message} (request ${e.requestId ?? "-"})`);
      res.status(502).send({ code: "STRIPE_ERROR", message: "We couldn't start the payment. Please try again." });
      return;
    }
    if (!sessionId) {
      sendPublicError(res, e);
      return;
    }
    console.error("In customer/create-order (saving the order)", e);
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
