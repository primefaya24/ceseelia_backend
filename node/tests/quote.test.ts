import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { createApp } from "../app";
import { quoteLimit } from "../api/v1/customer/quote";
import { initStoreCategory, initStoreSettings } from "../layers/core/interfaces/store";

const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = ulid();
const CAT = ulid();
const HIDDEN_CAT = ulid();
const TEA = ulid();
const CAKE = ulid();
const SECRET = ulid();
const AUD_ONLY = ulid();

const baseItem = (id: string, patch: object = {}) => ({
  storeItemId: id,
  storeItemCategoryId: CAT,
  storeItemName: id === TEA ? "Tea" : "Cake",
  storeItemImageUris: [],
  storeItemDescription: "",
  storeItemHashtagIds: [],
  storeItemIsActive: true,
  storeItemStock: -1,
  storeItemPrices: { USD: 1000, AUD: 1500 },
  storeItemDiscountPercent: 0,
  storeItemCustomParams: [],
  ...patch,
});

function liveStore(settingsPatch: object = {}) {
  const s = initStoreSettings();
  const settings = {
    ...s,
    currencies: [{ currencyCode: "USD", currencySign: "$", currencyIsDefault: true }],
    general: { ...s.general, discountPercent: 10 },
    ...settingsPatch,
  };
  const items = [
    baseItem(TEA, {
      storeItemStock: 5,
      storeItemCustomParams: [{ storeParamLabel: "Size", storeParamType: "SINGLE_SELECT", storeParamIsMandatory: true, storeParamOptions: ["S", "M"] }],
      storeItemVariants: ["S", "M"].map((o) => ({
        storeVariantOptions: { Size: o },
        storeVariantStock: 5,
        storeVariantPrices: { USD: 1000, AUD: 1500 },
        storeVariantIsActive: true,
      })),
    }),
    baseItem(CAKE, { storeItemDiscountPercent: 25, storeItemPrices: { USD: 333 } }),
    baseItem(SECRET, { storeItemCategoryId: HIDDEN_CAT }),
    baseItem(AUD_ONLY, { storeItemPrices: { AUD: 100 } }),
  ];
  const categories = [
    { ...initStoreCategory(CAT, "Drinks"), storeCategoryIsActive: true },
    { ...initStoreCategory(HIDDEN_CAT, "Secret"), storeCategoryIsActive: false },
  ];
  ddb.on(GetCommand).callsFake((input) => ({ Item: { ...input.Key, ...settings } }));
  ddb.on(QueryCommand).callsFake((input) =>
    input.ExpressionAttributeValues[":sk_prefix"] === "CATEGORY#" ? { Items: categories } : { Items: items }
  );
}

const quote = (body: object) => request(app).post("/api/v1/customer/quote").set("Host", "localhost").send(body);
const body = (lines: object[], patch: object = {}) => ({ storeId: STORE, currency: "USD", lines, ...patch });

beforeEach(() => {
  ddb.reset();
  quoteLimit.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /customer/quote (4.3)", () => {
  it("prices the cart with the store's public data", async () => {
    liveStore();
    const res = await quote(body([
      { itemId: TEA, quantity: 2, params: [{ label: "Size", values: ["M"] }] },
      { itemId: CAKE, quantity: 3 },
    ]));
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.ok).toBe(true);
    expect(res.body.lines.map((l: { itemName: string; discountSource: string; totalMinor: number }) => [l.itemName, l.discountSource, l.totalMinor])).toEqual([
      ["Tea", "STORE", 1800],
      ["Cake", "ITEM", 749],
    ]);
    expect(res.body).toMatchObject({ currency: "USD", subtotalMinor: 2999, discountMinor: 450, totalMinor: 2549 });
  });

  it("items in a hidden category and prices in currencies the store doesn't offer are never priced", async () => {
    liveStore();
    const res = await quote(body([{ itemId: SECRET, quantity: 1 }, { itemId: AUD_ONLY, quantity: 1 }]));
    expect(res.body.lines.map((l: { error: { code: string } }) => l.error.code)).toEqual(["ITEM_NOT_FOUND", "ITEM_NOT_FOUND"]);
    const aud = await quote(body([{ itemId: TEA, quantity: 1, params: [{ label: "Size", values: ["S"] }] }], { currency: "aud" }));
    expect(aud.body).toMatchObject({ ok: false, error: { code: "CURRENCY_NOT_OFFERED" } });
  });

  it("line problems come back per line with a 200", async () => {
    liveStore();
    const res = await quote(body([
      { itemId: TEA, quantity: 6, params: [{ label: "Size", values: ["S"] }] },
      { itemId: TEA, quantity: 1 },
      { itemId: "not-an-id", quantity: 1 },
    ]));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.lines.map((l: { error: { code: string } }) => l.error.code)).toEqual(["INSUFFICIENT_STOCK", "MISSING_PARAM", "ITEM_NOT_FOUND"]);
  });

  it("an empty cart is a 200 that isn't ok", async () => {
    liveStore();
    const res = await quote(body([]));
    expect(res.body).toMatchObject({ ok: false, lines: [], totalMinor: 0 });
  });

  it.each([
    ["a bad storeId", { storeId: "x" }],
    ["no lines array", { lines: "x" }],
    ["a line without a quantity", { lines: [{ itemId: "A" }] }],
    ["a non-string param value", { lines: [{ itemId: "A", quantity: 1, params: [{ label: "Size", values: [1] }] }] }],
    ["51 lines", { lines: Array.from({ length: 51 }, () => ({ itemId: "A", quantity: 1 })) }],
    ["an oversized label", { lines: [{ itemId: "A", quantity: 1, params: [{ label: "x".repeat(41), values: [] }] }] }],
    ["a long currency", { currency: "DOLLARS" }],
  ])("400 for %s", async (_n, patch) => {
    liveStore();
    expect((await quote(body([{ itemId: TEA, quantity: 1 }], patch))).status).toBe(400);
  });

  it("unknown and suspended stores get the storefront's 404s", async () => {
    ddb.on(GetCommand).resolves({});
    expect((await quote(body([]))).body.code).toBe("STORE_NOT_FOUND");
    liveStore({ admin: { isStoreLive: false } });
    expect((await quote(body([]))).body.code).toBe("STORE_UNAVAILABLE");
  });

  it("60 quotes per IP per minute, then 429 with Retry-After", async () => {
    liveStore();
    for (let i = 0; i < 60; i++) expect((await quote(body([]))).status).toBe(200);
    const res = await quote(body([]));
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("prices delivery and tax from the store's settings, and accepts a fulfilment choice (4.2)", async () => {
    const s = initStoreSettings();
    liveStore({ general: { ...s.general, discountPercent: 0, taxPercent: 10, deliveryEnabled: true, deliveryFees: { USD: 500 } } });
    const cake = { itemId: CAKE, quantity: 3 };
    const pickup = await quote(body([cake]));
    expect(pickup.body).toMatchObject({ fulfilment: "PICKUP", deliveryMinor: 0, taxMinor: 75, totalMinor: 824 });
    const delivery = await quote(body([cake], { fulfilment: "DELIVERY" }));
    expect(delivery.body).toMatchObject({ fulfilment: "DELIVERY", deliveryMinor: 500, taxMinor: 125, totalMinor: 1374, ok: true });
    expect((await quote(body([cake], { fulfilment: "COURIER" }))).status).toBe(400);
  });

  it("estimates Canadian delivery tax from the shopper's location, never from the body (QA Q.23)", async () => {
    const s = initStoreSettings();
    liveStore({
      general: {
        ...s.general,
        discountPercent: 0,
        taxMode: "CANADA",
        deliveryEnabled: true,
        deliveryFees: { USD: 0 },
        canadaTax: { homeProvince: "ON", gstRegistered: true, provincialRegistrations: [] },
      },
    });
    const cake = { itemId: CAKE, quantity: 3 }; // 999 - 25% = 749
    // Tests run as dev, where the shopper's IP is Australian: no province, so the store's own.
    const est = await quote(body([cake], { fulfilment: "DELIVERY" }));
    expect(est.body).toMatchObject({
      taxRegion: { province: "ON", estimated: true },
      taxLines: [{ code: "HST", minor: 97 }],
      taxMinor: 97,
      ok: true,
      error: null,
    });
    // A postal code (or anything else) in the body is ignored: the client can't pick the province.
    const sent = await quote(body([cake], { fulfilment: "DELIVERY", postalCode: "T2P 1J9", province: "AB" }));
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ taxRegion: { province: "ON", estimated: true }, taxMinor: 97 });
  });
});
