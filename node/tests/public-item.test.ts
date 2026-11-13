import { liveStoreSettings } from "./fixtures";
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { createApp } from "../app";
import { initStoreCategory, StoreCurrency } from "../layers/core/interfaces/store";

// STAGE=dev: the shopper looks Australian (AUD).
const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = ulid();
const ITEM = ulid();
const CAT = ulid();

const currency = (code: string, isDefault: boolean): StoreCurrency => ({
  currencyCode: code,
  currencySign: "$",
  currencyFloat: "LEFT",
  currencyIsDefault: isDefault,
});

type Rows = { settings?: object | null; item?: object | null; category?: object | null };
function rows({ settings, item, category }: Rows = {}) {
  const s =
    settings === undefined ? { ...liveStoreSettings(), currencies: [currency("USD", true), currency("AUD", false)] } : settings;
  const i =
    item === undefined
      ? {
          storeItemId: ITEM,
          storeItemName: "Pink Slay",
          storeItemCategoryId: CAT,
          storeItemIsActive: true,
          storeItemPrices: { USD: 6500, AUD: 9900, CAD: 8900 },
        }
      : item;
  const c =
    category === undefined ? { ...initStoreCategory(CAT, "Hoodies"), storeCategoriyId: CAT, storeCategoryIsActive: true } : category;
  ddb.on(GetCommand).callsFake((input) => {
    const sk = String(input.Key.sk);
    const row = sk === "SETTINGS" ? s : sk.startsWith("ITEM#") ? i : sk.startsWith("CATEGORY#") ? c : null;
    return row ? { Item: { ...input.Key, ...row } } : {};
  });
}
const get = (store = STORE, item = ITEM) =>
  request(app).get(`/api/v1/store/public/item/${store}/${item}`).set("Host", "localhost");

beforeEach(() => {
  ddb.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /store/public/item/:storeId/:itemId (3.3)", () => {
  it("returns the item, its category and the store's currencies", async () => {
    rows();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.storeId).toBe(STORE);
    expect(res.body.item.storeItemName).toBe("Pink Slay");
    expect(res.body.item).not.toHaveProperty("pk");
    expect(res.body.category.storeCategoryName).toBe("Hoodies");
    // Prices cut to the store's currencies; the Australian shopper's AUD is the default
    expect(res.body.item.storeItemPrices).toEqual({ USD: 6500, AUD: 9900 });
    expect(res.body.currencies.find((c: StoreCurrency) => c.currencyIsDefault).currencyCode).toBe("AUD");
    expect(res.body).not.toHaveProperty("settings");
  });

  it.each([
    ["a missing item", { item: null }],
    ["an inactive item", { item: { storeItemCategoryId: CAT, storeItemIsActive: false, storeItemPrices: { USD: 1 } } }],
    ["an item in an inactive category", { category: { storeCategoriyId: CAT, storeCategoryIsActive: false } }],
    ["an item whose category is gone", { category: null }],
    ["an item with no price in an offered currency", { item: { storeItemCategoryId: CAT, storeItemIsActive: true, storeItemPrices: { CAD: 1 } } }],
  ])("%s: 404 ITEM_NOT_FOUND", async (_n, patch) => {
    rows(patch as Rows);
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: "ITEM_NOT_FOUND", message: "Item not found" });
  });

  it("an unknown store: 404 STORE_NOT_FOUND", async () => {
    rows({ settings: null });
    expect((await get()).body.code).toBe("STORE_NOT_FOUND");
  });

  it("a suspended store: 404 STORE_UNAVAILABLE, even for a visible item", async () => {
    rows({ settings: { ...liveStoreSettings(), admin: { suspended: true } } });
    expect((await get()).body.code).toBe("STORE_UNAVAILABLE");
  });

  it("malformed ids are a 400 without a read", async () => {
    rows();
    expect((await get("not-a-ulid", ITEM)).status).toBe(400);
    expect((await get(STORE, "../x")).status).toBe(404); // path doesn't match the route
    expect(ddb.calls()).toHaveLength(0);
  });

  it("a read failure is a 500", async () => {
    ddb.on(GetCommand).rejects(new Error("throttled"));
    expect((await get()).status).toBe(500);
  });
});
