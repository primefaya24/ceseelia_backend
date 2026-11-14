import { liveStoreSettings } from "./fixtures";
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import Stripe from "stripe";
import { ulid } from "ulid";

vi.mock("../layers/payments/order-checkout", async (orig) => ({
  ...(await orig<typeof import("../layers/payments/order-checkout")>()),
  createOrderCheckout: vi.fn(),
  expireOrderCheckout: vi.fn(),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getStoreOverviewRow: vi.fn(),
}));

import { createApp } from "../app";
import { createOrderLimit } from "../api/v1/customer/create-order";
import { initStoreCategory } from "../layers/core/interfaces/store";
import { priceLines } from "../layers/core/pricing";
import {
  checkoutLineItems,
  createOrderCheckout,
  expireOrderCheckout,
  orderSessionParams,
  sumLineItems,
} from "../layers/payments/order-checkout";
import { getStoreOverviewRow } from "../layers/aws/dynamodb/dynamo-entities/membership";
import { hashStatusToken } from "../layers/aws/dynamodb/dynamo-entities/order";

const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = ulid();
const CAT = ulid();
const TEA = ulid();
const CAKE = ulid();

const item = (id: string, patch: object = {}) => ({
  storeItemId: id,
  storeItemCategoryId: CAT,
  storeItemName: id === TEA ? "Tea" : "Cake",
  storeItemImageUris: [],
  storeItemDescription: "",
  storeItemHashtagIds: [],
  storeItemIsActive: true,
  storeItemStock: -1,
  storeItemPrices: { USD: 1000 },
  storeItemDiscountPercent: 0,
  storeItemCustomParams: [],
  ...patch,
});

/* A live USD store: Tea 10.00, Cake 3.33 at 25% off; 10% tax added; delivery 5.00; Stripe on. */
function world(settingsPatch: object = {}, generalPatch: object = {}) {
  const s = liveStoreSettings();
  const settings = {
    ...s,
    currencies: [{ currencyCode: "USD", currencySign: "$", currencyIsDefault: true }],
    general: {
      ...s.general,
      taxPercent: 10,
      pricesIncludeTax: false,
      pickupEnabled: true,
      deliveryEnabled: true,
      deliveryFees: { USD: 500 },
      ...generalPatch,
    },
    payments: { stripeAccountId: "acct_store", chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
    ...settingsPatch,
  };
  const items = [item(TEA), item(CAKE, { storeItemDiscountPercent: 25, storeItemPrices: { USD: 333 } })];
  const categories = [{ ...initStoreCategory(CAT, "Drinks"), storeCategoryIsActive: true }];
  ddb.on(GetCommand).callsFake((input) => ({ Item: { ...input.Key, ...settings } }));
  ddb.on(QueryCommand).callsFake((input) =>
    input.ExpressionAttributeValues[":sk_prefix"] === "CATEGORY#" ? { Items: categories } : { Items: items }
  );
  ddb.on(TransactWriteCommand).resolves({});
}

const LINES = [
  { itemId: TEA, quantity: 2 },
  { itemId: CAKE, quantity: 3 },
];
// Tea 2000 + Cake 999 − 250 (25% of 999, half up) = 2749; tax 10% = 275; pickup total 3024.
const PICKUP_TOTAL = 3024;
const DELIVERY_TOTAL = 3024 + 500 + 50; // delivery is taxed too

const body = (patch: object = {}) => ({
  storeId: STORE,
  currency: "USD",
  fulfilment: "PICKUP",
  lines: LINES,
  expectedTotalMinor: PICKUP_TOTAL,
  customer: { name: " Ana Shopper ", email: "ana@example.com", phone: "+1 403 555 0100" },
  ...patch,
});
const ADDRESS = { line1: "1 Main St", city: "Calgary", region: "AB", postalCode: "t2p 1j9", country: "CA" };
const post = (b: object) => request(app).post("/api/v1/customer/create-order").set("Host", "localhost").send(b);
const savedOrder = () => ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems![0].Put!.Item!;

beforeEach(() => {
  ddb.reset();
  createOrderLimit.reset();
  vi.mocked(createOrderCheckout).mockReset().mockResolvedValue({ sessionId: "cs_1", url: "https://checkout.stripe/cs_1" });
  vi.mocked(expireOrderCheckout).mockReset().mockResolvedValue();
  vi.mocked(getStoreOverviewRow).mockReset().mockResolvedValue({ storeSlug: "northern-hoop" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /customer/create-order (5.4)", () => {
  it("re-prices, opens a session on the store's account and saves a PENDING_PAYMENT order", async () => {
    world();
    const res = await post(body());
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ checkoutUrl: "https://checkout.stripe/cs_1", totalMinor: PICKUP_TOTAL, currency: "USD" });
    expect(res.body.orderCode).toMatch(/^[2-9A-HJKMNP-TV-Z]{6}$/);

    const [params, account, orderId] = vi.mocked(createOrderCheckout).mock.calls[0];
    expect(account).toBe("acct_store");
    expect(orderId).toBe(res.body.orderId);
    expect(sumLineItems(params.line_items!)).toBe(PICKUP_TOTAL);
    // SPARK's fixed commission in USD (1.45), taken from the merchant
    expect(params.payment_intent_data!.application_fee_amount).toBe(145);
    expect(params.success_url).toContain("/s/northern-hoop/order/");

    const order = savedOrder();
    expect(order).toMatchObject({
      pk: `STORE#${STORE}`,
      storeOrderId: res.body.orderId,
      storeOrderStatus: "PENDING_PAYMENT",
      storeOrderType: "PICKUP",
      storeOrderAddress: null,
      storeOrderTotalMinor: PICKUP_TOTAL,
      storeOrderTaxMinor: 275,
      storeOrderPlatformFeeMinor: 145,
      storeOrderCommission: { source: "PLAN", plan: "SPARK", commissionMode: "FIXED" },
      storeOrderStripe: { accountId: "acct_store", checkoutSessionId: "cs_1", paymentIntentId: "" },
      storeOrderCustomer: { name: "Ana Shopper", email: "ana@example.com" },
    });
    expect(order.sk).toBe(`ORDER#${order.storeOrderCreatedAt}#${res.body.orderId}`);
    // Only the token's hash is kept
    expect(order.storeOrderStatusTokenHash).toBe(hashStatusToken(res.body.statusToken));
    expect(JSON.stringify(order)).not.toContain(res.body.statusToken);
    const pointer = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems![1].Put!.Item!;
    expect(pointer).toEqual({ pk: `ORDER#${res.body.orderId}`, sk: "ORDER", storeId: STORE, orderSk: order.sk });
  });

  it("a delivery is priced and saved with its address (postal code upper-cased)", async () => {
    world();
    const res = await post(body({ fulfilment: "DELIVERY", address: ADDRESS, expectedTotalMinor: DELIVERY_TOTAL }));
    expect(res.status).toBe(200);
    expect(savedOrder()).toMatchObject({
      storeOrderType: "DELIVERY",
      storeOrderDeliveryMinor: 500,
      storeOrderAddress: { ...ADDRESS, line2: "", postalCode: "T2P 1J9" },
    });
  });

  it("a Canada-taxed delivery is taxed on its postal code, never the geo-IP estimate", async () => {
    world({}, {
      taxMode: "CANADA",
      pricesIncludeTax: false,
      canadaTax: { homeProvince: "AB", gstRegistered: true, provincialRegistrations: [] },
    });
    // Ontario postal code: HST 13% on 2749 + 500
    const expected = 2749 + 500 + Math.round((2749 + 500) * 0.13);
    const res = await post(body({ fulfilment: "DELIVERY", address: { ...ADDRESS, region: "ON", postalCode: "M5V 2T6" }, expectedTotalMinor: expected }));
    expect(res.status).toBe(200);
    expect(savedOrder().storeOrderTaxRegion).toMatchObject({ province: "ON", estimated: false });

    const us = await post(body({ fulfilment: "DELIVERY", address: { ...ADDRESS, country: "US" }, expectedTotalMinor: expected }));
    expect([us.status, us.body.code]).toEqual([409, "DELIVERY_COUNTRY"]);
  });

  it("409 PRICE_CHANGED with the server's quote when the shown total differs", async () => {
    world();
    const res = await post(body({ expectedTotalMinor: PICKUP_TOTAL - 1 }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PRICE_CHANGED");
    expect(res.body.quote.totalMinor).toBe(PICKUP_TOTAL);
    expect(createOrderCheckout).not.toHaveBeenCalled();
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("409 CART_INVALID for an unbuyable line or a fulfilment the store doesn't offer", async () => {
    world();
    const gone = await post(body({ lines: [{ itemId: ulid(), quantity: 1 }] }));
    expect([gone.status, gone.body.code]).toEqual([409, "CART_INVALID"]);
    expect(gone.body.quote.lines[0].error.code).toBe("ITEM_NOT_FOUND");

    world({}, { deliveryEnabled: false });
    const noDelivery = await post(body({ fulfilment: "DELIVERY", address: ADDRESS }));
    expect([noDelivery.status, noDelivery.body.code]).toEqual([409, "CART_INVALID"]);
    expect(createOrderCheckout).not.toHaveBeenCalled();
  });

  it("409 PAYMENTS_UNAVAILABLE without a Stripe account or with charges off", async () => {
    world({ payments: {} });
    expect((await post(body())).body.code).toBe("PAYMENTS_UNAVAILABLE");
    world({ payments: { stripeAccountId: "acct_store", chargesEnabled: false } });
    expect((await post(body())).body.code).toBe("PAYMENTS_UNAVAILABLE");
    expect(createOrderCheckout).not.toHaveBeenCalled();
  });

  it("404s for a store that isn't open: draft or suspended", async () => {
    world({ lifecycle: { status: "DRAFT", plan: "NONE" } });
    const draft = await post(body());
    expect([draft.status, draft.body.code]).toEqual([404, "STORE_NOT_LIVE"]);
    world({ admin: { suspended: true } });
    expect((await post(body())).body.code).toBe("STORE_UNAVAILABLE");
  });

  it("409 BELOW_MINIMUM under Stripe's 0.50", async () => {
    world({}, { taxPercent: 0 });
    // Cake 3.33 − 25% = 2.50: fine
    const ok = await post(body({ lines: [{ itemId: CAKE, quantity: 1 }], expectedTotalMinor: 250 }));
    expect(ok.status).toBe(200);
    // A 0.40 tea: too small for Stripe
    ddb.on(QueryCommand).callsFake((input) =>
      input.ExpressionAttributeValues[":sk_prefix"] === "CATEGORY#"
        ? { Items: [{ ...initStoreCategory(CAT, "Drinks"), storeCategoryIsActive: true }] }
        : { Items: [item(TEA, { storeItemPrices: { USD: 40 } })] }
    );
    const res = await post(body({ lines: [{ itemId: TEA, quantity: 1 }], expectedTotalMinor: 40 }));
    expect([res.status, res.body.code]).toEqual([409, "BELOW_MINIMUM"]);
  });

  it("if the order can't be saved, the session is expired and nothing is returned", async () => {
    world();
    ddb.on(TransactWriteCommand).rejects(new Error("throttled"));
    const res = await post(body());
    expect(res.status).toBe(500);
    expect(expireOrderCheckout).toHaveBeenCalledWith("cs_1", "acct_store");
  });

  it("Stripe refusing: 502 STRIPE_ERROR, nothing saved", async () => {
    world();
    vi.mocked(createOrderCheckout).mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message: "nope" } as any)
    );
    const res = await post(body());
    expect([res.status, res.body.code]).toEqual([502, "STRIPE_ERROR"]);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each([
    ["no lines", { lines: [] }],
    ["bad email", { customer: { name: "A", email: "nope" } }],
    ["empty name", { customer: { name: "  ", email: "a@b.co" } }],
    ["bad phone", { customer: { name: "A", email: "a@b.co", phone: "call me" } }],
    ["delivery without an address", { fulfilment: "DELIVERY" }],
    ["delivery to an unsupported country", { fulfilment: "DELIVERY", address: { ...ADDRESS, country: "GB" } }],
    ["pickup with an address", { address: ADDRESS }],
    ["expected total not a whole number", { expectedTotalMinor: 10.5 }],
    ["long note", { note: "x".repeat(501) }],
    ["bad store id", { storeId: "nope" }],
  ])("400 for %s", async (_label, patch) => {
    world();
    expect((await post(body(patch))).status).toBe(400);
  });

  it("10 orders per IP per 10 minutes, then 429", async () => {
    world();
    for (let i = 0; i < 10; i++) await post(body({ expectedTotalMinor: 1 })); // refused, but counted
    const res = await post(body());
    expect([res.status, res.body.code]).toEqual([429, "RATE_LIMITED"]);
  });
});

describe("order Checkout Session params (5.4c)", () => {
  const store = (general: object) => ({
    settings: {
      currencies: [{ currencyCode: "USD", currencySign: "$", currencyIsDefault: true }],
      general: { pickupEnabled: true, deliveryEnabled: true, deliveryFees: { USD: 499 }, ...general },
    },
    categories: [{ ...initStoreCategory(CAT, "Drinks"), storeCategoryIsActive: true }],
    items: [item(TEA, { storeItemPrices: { USD: 333 }, storeItemDiscountPercent: 15 }) as any],
  });
  const lines = [{ itemId: TEA, quantity: 7, params: [] }];

  it.each([
    ["tax added", { taxPercent: 8.25, pricesIncludeTax: false }],
    ["tax included", { taxPercent: 13, pricesIncludeTax: true }],
    ["no tax", { taxPercent: 0 }],
  ])("the session's total is exactly the quote's total (%s), delivery included", (_l, general) => {
    for (const fulfilment of ["PICKUP", "DELIVERY"] as const) {
      const quote = priceLines(store(general) as any, lines, "USD", { fulfilment });
      expect(sumLineItems(checkoutLineItems(quote))).toBe(quote.totalMinor);
    }
  });

  it("never turns on Stripe tax or tax-id collection; fee and metadata on the payment", () => {
    const quote = priceLines(store({ taxPercent: 5 }) as any, lines, "USD", { fulfilment: "DELIVERY" });
    const p = orderSessionParams({ orderId: "O1", storeId: "S1", storeSlug: "hoop", quote, feeMinor: 145, customerEmail: "a@b.co", now: 0 });
    expect(p).not.toHaveProperty("automatic_tax");
    expect(p).not.toHaveProperty("tax_id_collection");
    expect(p).toMatchObject({
      mode: "payment",
      client_reference_id: "O1",
      metadata: { orderId: "O1", storeId: "S1" },
      payment_intent_data: { application_fee_amount: 145, metadata: { orderId: "O1", storeId: "S1" } },
      expires_at: 30 * 60,
    });
    expect(p.success_url).not.toContain("token");
    const names = checkoutLineItems(quote).map((l) => l.price_data!.product_data!.name);
    expect(names).toEqual(["Tea × 7", "Delivery", "Tax 5%"]);
  });
});
