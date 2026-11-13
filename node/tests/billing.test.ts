import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import Stripe from "stripe";
import { mockClient } from "aws-sdk-client-mock";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  findUserIdByCognitoId: vi.fn(async () => "USER1"),
  getMyProfile: vi.fn(async () => ({ info: { userEmailAddress: "m@example.com", userFirstName: "Mo", userLastName: "Ra" } })),
}));
const role = { current: "ADMIN" as "ADMIN" | "MERCHANT" };
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getMembership: vi.fn(async (storeId: string, userId: string) => ({ storeId, userId, role: role.current, createdAt: 1 })),
  findLiveFreeStoreAdministeredBy: vi.fn(async () => null),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/store", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/store")>()),
  getStoreInventoryData: vi.fn(),
  deleteStore: vi.fn(async () => true),
}));
vi.mock("../layers/payments/account-status", async (orig) => ({
  ...(await orig<typeof import("../layers/payments/account-status")>()),
  readStoreStripeAccount: vi.fn(),
}));
vi.mock("../layers/core/store-validation", async (orig) => ({
  ...(await orig<typeof import("../layers/core/store-validation")>()),
  runSmartStoreValidation: vi.fn(async () => ({ ok: true })),
}));
const realStripe = new Stripe("sk_test_123");
const stripe = {
  prices: { list: vi.fn() },
  customers: { create: vi.fn() },
  checkout: { sessions: { create: vi.fn(), expire: vi.fn() } },
  billingPortal: { sessions: { create: vi.fn() } },
  subscriptions: { retrieve: vi.fn(), cancel: vi.fn() },
  webhooks: realStripe.webhooks,
};
const secrets = { secretKey: "sk_test_123", webhookSecret: "whsec_connect", billingWebhookSecret: "whsec_billing" };
vi.mock("../layers/payments/stripe", async (orig) => ({
  ...(await orig<typeof import("../layers/payments/stripe")>()),
  getStripe: vi.fn(async () => stripe),
  getStripeSecrets: vi.fn(async () => secrets),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { findLiveFreeStoreAdministeredBy } from "../layers/aws/dynamodb/dynamo-entities/membership";
import { deleteStore, getStoreInventoryData } from "../layers/aws/dynamodb/dynamo-entities/store";
import { readStoreStripeAccount } from "../layers/payments/account-status";
import { runSmartStoreValidation } from "../layers/core/store-validation";
import { initStoreCategory, initStoreSettings, StoreInventoryData, StoreLifecycle } from "../layers/core/interfaces/store";
import { planFromLookupKey, setPaidPlansEnabledForTests } from "../layers/core/plans";
import {
  blocksNewSubscription,
  DAY_MS,
  lifecycleAfter,
  mayReplace,
  planEffect,
  SubscriptionSnapshot,
} from "../layers/core/billing";
import { resetBillingPriceCache, resolvePlanPrice, toSnapshot } from "../layers/payments/billing";
import { subscriptionIdOf } from "../layers/payments/billing-webhook";
import { sweepExpiredGrace, syncSubscription } from "../layers/payments/subscription-sync";
import { createApp } from "../app";

const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = "01JBZ0000000000000000000AA";
const USER = "USER1";
const NOW = 1_800_000_000_000;

// ─── fixtures ────────────────────────────────────────────────────────────────
const snap = (p: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot => ({
  id: "sub_1",
  customerId: "cus_1",
  status: "active",
  plan: "SPARK",
  currency: "CAD",
  currentPeriodEnd: NOW + 30 * DAY_MS,
  cancelAtPeriodEnd: false,
  cancellationReason: null,
  endedAt: null,
  metadata: { storeId: STORE, userId: USER },
  ...p,
});
const stripeSub = (p: Record<string, unknown> = {}) => ({
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  currency: "cad",
  cancel_at_period_end: false,
  cancel_at: null,
  ended_at: null,
  cancellation_details: { reason: null },
  metadata: { storeId: STORE, userId: USER, plan: "SPARK" },
  items: { data: [{ price: { lookup_key: "ceseelia_spark_cad" }, current_period_end: NOW / 1000 + 30 * 86400 }] },
  ...p,
});
const record = (p: Record<string, unknown> = {}) => ({
  subscriptionId: "sub_1",
  customerId: "cus_1",
  payerUserId: USER,
  plan: "SPARK",
  currency: "CAD",
  status: "active",
  currentPeriodEnd: NOW + 30 * DAY_MS,
  cancelAtPeriodEnd: false,
  graceEndsAt: null,
  syncedAt: 1,
  ...p,
});
let settingsRow: Record<string, unknown> | null;
const withSettings = (p: Record<string, unknown> = {}) => {
  settingsRow = {
    pk: `STORE#${STORE}`,
    sk: "SETTINGS",
    lifecycle: { status: "DRAFT", plan: "FREE" },
    admin: { suspended: false },
    storeInfo: { storeName: "Hoop" },
    ...p,
  };
};
const lc = (status: StoreLifecycle["status"], plan: StoreLifecycle["plan"]): StoreLifecycle => ({ status, plan });
const txUpdate = (i = 0) => ddb.commandCalls(TransactWriteCommand)[i]?.args[0].input.TransactItems ?? [];
const savedSub = (i = 0) => txUpdate(i)[0].Update!.ExpressionAttributeValues![":sub"];
const savedLifecycle = (i = 0) => txUpdate(i)[0].Update!.ExpressionAttributeValues![":lc"];

function readyStore(): StoreInventoryData {
  const s = initStoreSettings();
  const cat = "01JBZ0000000000000000000CC";
  return {
    settings: {
      ...s,
      storeInfo: { ...s.storeInfo, storeName: "Hoop" },
      general: { ...s.general, pickupEnabled: true, pickupAddress: "1 Main St" },
      lifecycle: { status: "DRAFT", plan: "FREE" },
    },
    categories: [{ ...initStoreCategory(cat, "Hoops"), storeCategoriyId: cat, storeCategoryIsActive: true }],
    items: [
      {
        storeItemId: "01JBZ0000000000000000000DD",
        storeItemName: "Hoop",
        storeItemCategoryId: cat,
        storeItemIsActive: true,
        storeItemStock: -1,
        storeItemPrices: { CAD: 1000, USD: 800, AUD: 1100 },
        storeItemImageUris: [],
        storeItemDescription: "",
        storeItemHashtagIds: [],
        storeItemDiscountPercent: 0,
        storeItemCustomParams: [],
      } as never,
    ],
  };
}

const auth = () => request(app);
const post = (path: string, body: object) =>
  auth().post(`/api/v1/store${path}`).set("Host", "localhost").set("Authorization", "Bearer t").send(body);
const get = (path: string) => auth().get(`/api/v1/store${path}`).set("Host", "localhost").set("Authorization", "Bearer t");

beforeEach(() => {
  ddb.reset();
  vi.clearAllMocks();
  resetBillingPriceCache();
  setPaidPlansEnabledForTests(true);
  role.current = "ADMIN";
  secrets.billingWebhookSecret = "whsec_billing";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "m", "cognito:groups": [] });
  vi.mocked(findLiveFreeStoreAdministeredBy).mockResolvedValue(null);
  vi.mocked(getStoreInventoryData).mockResolvedValue(readyStore());
  vi.mocked(runSmartStoreValidation).mockResolvedValue({ ok: true });
  vi.mocked(readStoreStripeAccount).mockResolvedValue({
    connected: true,
    account: { country: "CA" } as Stripe.Account,
    chargesEnabled: true,
    payoutsEnabled: true,
    detailsSubmitted: true,
  });
  withSettings();
  ddb.on(GetCommand).callsFake((input) => {
    if (input.Key.sk === "SETTINGS") return { Item: settingsRow ?? undefined };
    return {}; // no billing customer yet
  });
  ddb.on(TransactWriteCommand).resolves({});
  ddb.on(UpdateCommand).resolves({});
  ddb.on(PutCommand).resolves({});
  stripe.prices.list.mockResolvedValue({
    data: [{ id: "price_spark_cad", currency: "cad", unit_amount: 2500, type: "recurring", recurring: { interval: "month", interval_count: 1 } }],
  });
  stripe.customers.create.mockResolvedValue({ id: "cus_new" });
  stripe.checkout.sessions.create.mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" });
  stripe.billingPortal.sessions.create.mockResolvedValue({ url: "https://billing.stripe.com/p/1" });
  stripe.subscriptions.retrieve.mockResolvedValue(stripeSub());
  stripe.subscriptions.cancel.mockResolvedValue({});
});

// ─── pure rules ──────────────────────────────────────────────────────────────
describe("subscription rules (P.5)", () => {
  it("lookup keys map to paid plans only", () => {
    expect(planFromLookupKey("ceseelia_nova_usd")).toEqual({ plan: "NOVA", currency: "USD" });
    for (const bad of ["ceseelia_free_cad", "ceseelia_spark_eur", "other_spark_cad", null, 5]) {
      expect(planFromLookupKey(bad)).toBeNull();
    }
  });

  it.each([
    ["active", null, { kind: "PAID", plan: "SPARK" }],
    ["trialing", null, { kind: "PAID", plan: "SPARK" }],
    ["past_due", null, { kind: "PAID", plan: "SPARK" }], // Stripe is still retrying
    ["incomplete", null, { kind: "NONE" }],
    ["incomplete_expired", null, { kind: "NONE" }],
    ["unpaid", null, { kind: "GRACE", plan: "SPARK", until: NOW + 7 * DAY_MS }],
    ["canceled", "payment_failed", { kind: "GRACE", plan: "SPARK", until: NOW + 7 * DAY_MS }],
    ["canceled", "cancellation_requested", { kind: "FREE" }],
  ])("%s (%s) → %j", (status, reason, effect) => {
    expect(planEffect(snap({ status, cancellationReason: reason }), null, NOW)).toEqual(effect);
  });

  it("grace keeps its end once started, then FREE; a price that isn't ours changes nothing", () => {
    const lost = snap({ status: "unpaid" });
    expect(planEffect(lost, NOW + DAY_MS, NOW)).toEqual({ kind: "GRACE", plan: "SPARK", until: NOW + DAY_MS });
    expect(planEffect(lost, NOW - 1, NOW)).toEqual({ kind: "FREE" });
    expect(planEffect(snap({ plan: null }), null, NOW)).toEqual({ kind: "NONE" });
  });

  it("a paid draft goes live; a live store changes plan; drops to FREE, or DRAFT when the account has a live FREE store", () => {
    const opts = { now: NOW, otherLiveFreeStore: false };
    expect(lifecycleAfter({ ...lc("DRAFT", "FREE"), pausedReason: "FREE_PLAN_IN_USE" }, { kind: "PAID", plan: "NOVA" }, opts)).toEqual({
      status: "LIVE",
      plan: "NOVA",
      statusChangedAt: NOW,
      firstLiveAt: NOW,
    });
    expect(lifecycleAfter(lc("LIVE", "SPARK"), { kind: "PAID", plan: "NOVA" }, opts)).toEqual(lc("LIVE", "NOVA"));
    expect(lifecycleAfter(lc("IN_REVIEW", "FREE"), { kind: "PAID", plan: "SPARK" }, opts)).toEqual(lc("IN_REVIEW", "SPARK"));
    expect(lifecycleAfter(lc("DRAFT", "FREE"), { kind: "GRACE", plan: "SPARK", until: 1 }, opts).status).toBe("DRAFT");
    expect(lifecycleAfter(lc("LIVE", "SPARK"), { kind: "FREE" }, opts)).toEqual(lc("LIVE", "FREE"));
    expect(lifecycleAfter(lc("LIVE", "SPARK"), { kind: "FREE" }, { now: NOW, otherLiveFreeStore: true })).toEqual({
      status: "DRAFT",
      plan: "FREE",
      statusChangedAt: NOW,
      pausedReason: "FREE_PLAN_IN_USE",
    });
    const same = lc("LIVE", "FREE");
    expect(lifecycleAfter(same, { kind: "FREE" }, opts)).toBe(same);
  });

  it("one subscription per store: an old one's late events never undo a newer one", () => {
    expect(blocksNewSubscription(undefined, NOW)).toBe(false);
    expect(blocksNewSubscription(record() as never, NOW)).toBe(true);
    expect(blocksNewSubscription(record({ status: "unpaid", graceEndsAt: NOW + 1 }) as never, NOW)).toBe(true);
    expect(blocksNewSubscription(record({ status: "canceled" }) as never, NOW)).toBe(false);
    expect(mayReplace(record() as never, snap({ id: "sub_2" }), NOW)).toBe(false);
    expect(mayReplace(record({ status: "canceled" }) as never, snap({ id: "sub_2" }), NOW)).toBe(true);
    expect(mayReplace(record({ status: "canceled" }) as never, snap({ id: "sub_2", status: "incomplete" }), NOW)).toBe(false);
  });

  it("reads a Stripe subscription (plan from the price, period from its item)", () => {
    expect(toSnapshot(stripeSub({ cancel_at: 123, status: "past_due" }) as never)).toMatchObject({
      id: "sub_1",
      customerId: "cus_1",
      status: "past_due",
      plan: "SPARK",
      currency: "CAD",
      currentPeriodEnd: NOW + 30 * DAY_MS,
      cancelAtPeriodEnd: true,
      metadata: { storeId: STORE, userId: USER },
    });
  });

  it("only charges a price that matches PLANS exactly", async () => {
    expect(await resolvePlanPrice("SPARK", "CAD")).toBe("price_spark_cad");
    resetBillingPriceCache();
    stripe.prices.list.mockResolvedValue({
      data: [{ id: "p", currency: "cad", unit_amount: 2000, type: "recurring", recurring: { interval: "month", interval_count: 1 } }],
    });
    await expect(resolvePlanPrice("SPARK", "CAD")).rejects.toThrow(/doesn't match 2500 CAD/);
    stripe.prices.list.mockResolvedValue({ data: [] });
    await expect(resolvePlanPrice("NOVA", "USD")).rejects.toThrow(/missing/);
  });
});

// ─── sync ────────────────────────────────────────────────────────────────────
describe("syncSubscription (P.5)", () => {
  it("a paid subscription takes a draft live on its plan and closes the checkout", async () => {
    withSettings({ billingCheckout: { sessionId: "cs_1", url: "u", plan: "SPARK", userId: USER, expiresAt: NOW } });
    expect(await syncSubscription("sub_1", () => NOW)).toBe("UPDATED");
    expect(savedLifecycle()).toMatchObject({ status: "LIVE", plan: "SPARK", firstLiveAt: NOW });
    expect(savedSub()).toMatchObject({ subscriptionId: "sub_1", payerUserId: USER, plan: "SPARK", status: "active", graceEndsAt: null });
    const upd = txUpdate()[0].Update!;
    expect(upd.UpdateExpression).toContain("REMOVE #co");
    expect(upd.ConditionExpression).toContain("#lc.#st = :st AND #lc.#pl = :pl");
    expect(upd.ConditionExpression).toContain("attribute_not_exists(#sub)");
  });

  it("the same event twice writes once", async () => {
    withSettings({ lifecycle: { status: "LIVE", plan: "SPARK" }, subscription: record() });
    expect(await syncSubscription("sub_1", () => NOW)).toBe("UNCHANGED");
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("payment failed for good: 7 days' grace on the plan (listed for the sweep), then FREE", async () => {
    withSettings({ lifecycle: { status: "LIVE", plan: "SPARK" }, subscription: record({ status: "past_due" }) });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub({ status: "unpaid" }));
    await syncSubscription("sub_1", () => NOW);
    expect(savedLifecycle()).toBeUndefined();
    expect(savedSub().graceEndsAt).toBe(NOW + 7 * DAY_MS);
    expect(txUpdate()[1].Put!.Item).toMatchObject({ pk: "APP_BILLING_GRACE", sk: `STORE#${STORE}`, graceEndsAt: NOW + 7 * DAY_MS });

    withSettings({ lifecycle: { status: "LIVE", plan: "SPARK" }, subscription: record({ status: "unpaid", graceEndsAt: NOW + 7 * DAY_MS }) });
    await syncSubscription("sub_1", () => NOW + 8 * DAY_MS);
    expect(savedLifecycle(1)).toMatchObject({ status: "LIVE", plan: "FREE" });
    expect(savedSub(1).graceEndsAt).toBeNull();
    expect(txUpdate(1)[1].Delete!.Key).toEqual({ pk: "APP_BILLING_GRACE", sk: `STORE#${STORE}` });
  });

  it("cancelled: FREE when it ends; DRAFT (and why) when the payer already has a live FREE store", async () => {
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub({ status: "canceled", cancellation_details: { reason: "cancellation_requested" } }));
    withSettings({ lifecycle: { status: "LIVE", plan: "NOVA" }, subscription: record({ plan: "NOVA" }) });
    vi.mocked(findLiveFreeStoreAdministeredBy).mockResolvedValueOnce("OTHER");
    await syncSubscription("sub_1", () => NOW);
    expect(findLiveFreeStoreAdministeredBy).toHaveBeenCalledWith(USER, STORE);
    expect(savedLifecycle()).toMatchObject({ status: "DRAFT", plan: "FREE", pausedReason: "FREE_PLAN_IN_USE" });
  });

  it("a second subscription for a store that already pays is cancelled; an old one's events are ignored", async () => {
    withSettings({ lifecycle: { status: "LIVE", plan: "SPARK" }, subscription: record({ subscriptionId: "sub_0" }) });
    expect(await syncSubscription("sub_1", () => NOW)).toBe("DUPLICATE_CANCELLED");
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_1", { prorate: true });

    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub({ status: "canceled" }));
    expect(await syncSubscription("sub_1", () => NOW)).toBe("IGNORED_OLDER");
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("ignores subscriptions that aren't a store's; cancels one whose store was deleted", async () => {
    stripe.subscriptions.retrieve.mockResolvedValueOnce(stripeSub({ metadata: {} }));
    expect(await syncSubscription("sub_1")).toBe("NOT_OURS");
    settingsRow = null;
    expect(await syncSubscription("sub_1")).toBe("STORE_GONE");
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_1", { prorate: true });
  });

  it("reads again when the store changed between the read and the write", async () => {
    ddb
      .on(TransactWriteCommand)
      .rejectsOnce(
        new TransactionCanceledException({ message: "x", $metadata: {}, CancellationReasons: [{ Code: "ConditionalCheckFailed" }] })
      )
      .resolves({});
    expect(await syncSubscription("sub_1", () => NOW)).toBe("UPDATED");
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(2);
  });

  it("the sweep re-syncs stores whose grace ended", async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ storeId: STORE, graceEndsAt: NOW - 1 }] });
    ddb.on(DeleteCommand).resolves({});
    withSettings({ lifecycle: { status: "LIVE", plan: "SPARK" }, subscription: record({ status: "unpaid", graceEndsAt: NOW - 1 }) });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub({ status: "unpaid" }));
    expect(await sweepExpiredGrace(() => NOW)).toBe(1);
    expect(savedLifecycle()).toMatchObject({ plan: "FREE" });
  });
});

// ─── webhook ─────────────────────────────────────────────────────────────────
describe("POST /api/v1/billing/stripe-webhook (P.5)", () => {
  const send = (event: object, secret = "whsec_billing") => {
    const payload = JSON.stringify(event);
    return request(app)
      .post("/api/v1/billing/stripe-webhook")
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", realStripe.webhooks.generateTestHeaderString({ payload, secret }))
      .send(payload);
  };
  const event = (type: string, object: object, extra: object = {}) => ({ id: "evt_1", object: "event", type, data: { object }, ...extra });

  it("400 for a bad or missing signature; 503 until its secret is set", async () => {
    expect((await send(event("invoice.paid", {}), "whsec_wrong")).status).toBe(400);
    expect((await request(app).post("/api/v1/billing/stripe-webhook").send({})).status).toBe(400);
    secrets.billingWebhookSecret = "";
    expect((await send(event("invoice.paid", {}))).status).toBe(503);
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("each event syncs the subscription it's about, read fresh from Stripe", async () => {
    const res = await send(event("checkout.session.completed", { id: "cs_1", mode: "subscription", subscription: "sub_1" }));
    expect(res.status).toBe(200);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_1");
    expect(savedLifecycle()).toMatchObject({ status: "LIVE", plan: "SPARK" });
  });

  it("finds the subscription in every event it handles", () => {
    const e = (type: string, object: object) => event(type, object) as unknown as Stripe.Event;
    expect(subscriptionIdOf(e("customer.subscription.deleted", { id: "sub_9" }))).toBe("sub_9");
    expect(subscriptionIdOf(e("invoice.payment_failed", { parent: { subscription_details: { subscription: "sub_8" } } }))).toBe("sub_8");
    expect(subscriptionIdOf(e("checkout.session.completed", { mode: "payment", subscription: null }))).toBeNull();
    expect(subscriptionIdOf(e("charge.succeeded", { id: "ch_1" }))).toBeNull();
  });

  it("Connect events and events we don't use: 200, nothing done; a failure: 500 so Stripe retries", async () => {
    expect((await send(event("customer.subscription.updated", { id: "sub_1" }, { account: "acct_1" }))).status).toBe(200);
    expect((await send(event("charge.succeeded", { id: "ch_1" }))).status).toBe(200);
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    stripe.subscriptions.retrieve.mockRejectedValueOnce(new Error("down"));
    expect((await send(event("customer.subscription.updated", { id: "sub_1" }))).status).toBe(500);
  });

  it("an expired checkout is forgotten", async () => {
    await send(event("checkout.session.expired", { id: "cs_1", mode: "subscription", metadata: { storeId: STORE } }));
    const upd = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.UpdateExpression).toBe("REMOVE #co");
    expect(upd.ExpressionAttributeValues).toEqual({ ":sid": "cs_1" });
  });
});

// ─── routes ──────────────────────────────────────────────────────────────────
describe("Go Live on a paid plan (P.5)", () => {
  it("returns a Billing Checkout URL; the store stays a draft until it's paid", async () => {
    const res = await post("/go-live", { storeId: STORE, plan: "SPARK" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "DRAFT", plan: "SPARK", checkoutUrl: "https://checkout.stripe.com/c/cs_1" });
    const args = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(args).toMatchObject({
      mode: "subscription",
      customer: "cus_new",
      line_items: [{ price: "price_spark_cad", quantity: 1 }],
      automatic_tax: { enabled: true },
      metadata: { storeId: STORE, userId: USER, plan: "SPARK" },
      subscription_data: { metadata: { storeId: STORE, userId: USER, plan: "SPARK" } },
    });
    expect(args.success_url).toMatch(new RegExp(`/store/storefront/${STORE}\\?billing=success$`));
    expect(stripe.customers.create.mock.calls[0][1]).toEqual({ idempotencyKey: "ceseelia-billing-customer-USER1-CAD" });
    // Only the open checkout is saved, never the lifecycle.
    const writes = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input.UpdateExpression);
    expect(writes).toEqual(["SET #co = :co"]);
  });

  it("a second click reuses the open checkout; another plan replaces it", async () => {
    withSettings({ billingCheckout: { sessionId: "cs_0", url: "https://open", plan: "SPARK", userId: USER, expiresAt: Date.now() + 3600_000 } });
    expect((await post("/go-live", { storeId: STORE, plan: "SPARK" })).body.checkoutUrl).toBe("https://open");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    stripe.prices.list.mockResolvedValue({
      data: [{ id: "price_nova_cad", currency: "cad", unit_amount: 4900, type: "recurring", recurring: { interval: "month", interval_count: 1 } }],
    });
    await post("/go-live", { storeId: STORE, plan: "NOVA" });
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_0");
  });

  it("a flagged store goes to IN_REVIEW without taking a card", async () => {
    vi.mocked(runSmartStoreValidation).mockResolvedValue({ ok: false, reasons: ["X"] });
    const res = await post("/go-live", { storeId: STORE, plan: "NOVA" });
    expect(res.body).toEqual({ status: "IN_REVIEW", plan: "NOVA" });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("409 ALREADY_SUBSCRIBED; 503 BILLING_NOT_CONFIGURED when the price isn't set up", async () => {
    withSettings({ subscription: record() });
    expect((await post("/go-live", { storeId: STORE, plan: "SPARK" })).body.code).toBe("ALREADY_SUBSCRIBED");
    withSettings();
    stripe.prices.list.mockResolvedValue({ data: [] });
    const res = await post("/go-live", { storeId: STORE, plan: "SPARK" });
    expect([res.status, res.body.code]).toEqual([503, "BILLING_NOT_CONFIGURED"]);
  });
});

describe("/store/billing (P.5)", () => {
  it("checkout: a live FREE store upgrades; drafts, paying stores and FREE are refused", async () => {
    withSettings({ lifecycle: { status: "LIVE", plan: "FREE" } });
    expect((await post("/billing/checkout", { storeId: STORE, plan: "SPARK" })).body.checkoutUrl).toBe("https://checkout.stripe.com/c/cs_1");
    expect((await post("/billing/checkout", { storeId: STORE, plan: "FREE" })).status).toBe(400);
    withSettings({ lifecycle: { status: "LIVE", plan: "SPARK" }, subscription: record() });
    expect((await post("/billing/checkout", { storeId: STORE, plan: "NOVA" })).body.code).toBe("ALREADY_SUBSCRIBED");
    withSettings();
    expect((await post("/billing/checkout", { storeId: STORE, plan: "NOVA" })).body.code).toBe("NOT_LIVE");
    role.current = "MERCHANT";
    expect((await post("/billing/checkout", { storeId: STORE, plan: "NOVA" })).status).toBe(403);
  });

  it("portal: only the person who subscribed", async () => {
    withSettings({ subscription: record() });
    expect((await post("/billing/portal", { storeId: STORE })).body).toEqual({ url: "https://billing.stripe.com/p/1" });
    expect(stripe.billingPortal.sessions.create.mock.calls[0][0]).toMatchObject({ customer: "cus_1" });
    withSettings({ subscription: record({ payerUserId: "SOMEONE_ELSE" }) });
    expect((await post("/billing/portal", { storeId: STORE })).body.code).toBe("NOT_PAYER");
    withSettings();
    expect((await post("/billing/portal", { storeId: STORE })).body.code).toBe("NO_SUBSCRIPTION");
  });

  it("status: plan and subscription for members, no Stripe ids", async () => {
    role.current = "MERCHANT";
    withSettings({ lifecycle: { status: "LIVE", plan: "SPARK" }, subscription: record({ cancelAtPeriodEnd: true }) });
    const res = await get(`/billing/status/${STORE}`);
    expect(res.body).toEqual({
      status: "LIVE",
      plan: "SPARK",
      pausedReason: null,
      suspended: false,
      canManage: false,
      checkoutPending: false,
      subscription: {
        plan: "SPARK",
        status: "active",
        currency: "CAD",
        currentPeriodEnd: NOW + 30 * DAY_MS,
        cancelAtPeriodEnd: true,
        graceEndsAt: null,
        isPayer: true,
      },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/sub_1|cus_1/);
  });
});

describe("deleting a store stops its subscription (P.5)", () => {
  const del = () =>
    request(app).delete(`/api/v1/store/delete/${STORE}`).set("Host", "localhost").set("Authorization", "Bearer t");

  beforeEach(() => vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "a", "cognito:groups": ["Admins"] }));

  it("cancels it first; if Stripe fails, nothing is deleted", async () => {
    withSettings({ subscription: record() });
    expect((await del()).status).toBe(200);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_1", { prorate: true });
    stripe.subscriptions.cancel.mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({ message: "down" }));
    vi.mocked(deleteStore).mockClear();
    expect((await del()).status).toBe(502);
    expect(deleteStore).not.toHaveBeenCalled();
  });
});
