import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { createApp } from "../app";
import { toPublicInventory, toPublicSettings } from "../layers/aws/dynamodb/dynamo-entities/store";
import { initStoreCategory, initStoreSettings, StoreItem } from "../layers/core/interfaces/store";

const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = ulid();
const A = ulid(); // active category
const OFF = ulid(); // inactive category
const GONE = ulid(); // deleted category

const category = (id: string, active: boolean, count = 99) => ({
  ...initStoreCategory(id, id),
  storeCategoriyId: id,
  storeCategoryIsActive: active,
  storeCategoryItemCount: count,
});
const item = (name: string, categoryId: string, active = true, storeItemPrices: object = { USD: 6500 }) =>
  ({
    storeItemId: ulid(),
    storeItemName: name,
    storeItemCategoryId: categoryId,
    storeItemIsActive: active,
    storeItemPrices,
  }) as StoreItem;

const inventory = () => ({
  settings: initStoreSettings(),
  categories: [category(A, true), category(OFF, false)],
  items: [
    item("shown", A),
    item("also shown", A),
    item("inactive item", A, false),
    item("in inactive category", OFF),
    item("orphan", GONE),
  ],
});

/* SETTINGS (or none), plus the category and item rows the queries return. */
function store(settings: Record<string, unknown> | null) {
  ddb.on(GetCommand).resolves(settings ? { Item: { pk: `STORE#${STORE}`, sk: "SETTINGS", ...settings } } : {});
  const data = inventory();
  ddb.on(QueryCommand).callsFake((input) =>
    input.ExpressionAttributeValues[":sk_prefix"] === "CATEGORY#"
      ? { Items: data.categories }
      : { Items: data.items }
  );
}
const get = () => request(app).get(`/api/v1/store/inventory/get-data-public/${STORE}`).set("Host", "localhost");

beforeEach(() => {
  ddb.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("toPublicInventory (2.4b)", () => {
  it("keeps only active items in active categories, and counts only those", () => {
    const out = toPublicInventory(inventory());
    expect(out.categories.map((c) => c.storeCategoriyId)).toEqual([A]);
    expect(out.items.map((i) => i.storeItemName)).toEqual(["shown", "also shown"]);
    expect(out.categories[0].storeCategoryItemCount).toBe(2);
  });

  it("never includes the admin block (2.4a)", () => {
    expect(toPublicInventory(inventory()).settings).not.toHaveProperty("admin");
  });

  it("an active category with nothing shown has a count of 0", () => {
    const data = inventory();
    data.items = [];
    expect(toPublicInventory(data).categories[0].storeCategoryItemCount).toBe(0);
  });
});

describe("store email on the storefront (showEmail)", () => {
  const withEmail = (showEmail?: boolean) => {
    const base = initStoreSettings();
    return { ...base, storeInfo: { ...base.storeInfo, emailaddress: "hi@hoop.test", ...(showEmail === undefined ? {} : { showEmail }) } };
  };

  it("is shown by default (settings saved before the toggle) and when on", () => {
    expect(toPublicSettings(withEmail()).storeInfo).toMatchObject({ emailaddress: "hi@hoop.test", contactFormAvailable: true });
    expect(toPublicSettings(withEmail(true)).storeInfo.emailaddress).toBe("hi@hoop.test");
  });

  it("is left out of the public data when hidden, but Contact us stays available", () => {
    const info = toPublicInventory({ ...inventory(), settings: withEmail(false) }).settings.storeInfo;
    expect(info.emailaddress).toBe("");
    expect(JSON.stringify(info)).not.toContain("hi@hoop.test");
    expect(info.contactFormAvailable).toBe(true);
  });

  it("no email: no Contact us; a contactFormAvailable sent in is not trusted", () => {
    const base = initStoreSettings();
    const forged = { ...base, storeInfo: { ...base.storeInfo, contactFormAvailable: true } };
    expect(toPublicSettings(forged).storeInfo.contactFormAvailable).toBe(false);
  });

  it("the phone number can be hidden on its own, or both together", () => {
    const base = initStoreSettings();
    const info = (extra: object) =>
      toPublicSettings({ ...base, storeInfo: { ...base.storeInfo, emailaddress: "hi@hoop.test", phoneNumber: "+1 416 555 0142", ...extra } })
        .storeInfo;
    expect(info({ showPhone: false })).toMatchObject({ phoneNumber: "", emailaddress: "hi@hoop.test" });
    expect(info({})).toMatchObject({ phoneNumber: "+1 416 555 0142" });
    const both = info({ showPhone: false, showEmail: false });
    expect(both).toMatchObject({ phoneNumber: "", emailaddress: "", contactFormAvailable: true });
  });

  it("the public endpoint hides it too", async () => {
    store({ ...withEmail(false) });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("hi@hoop.test");
    expect(res.body.settings.storeInfo.contactFormAvailable).toBe(true);
  });
});

describe("toPublicInventory prices (2.5)", () => {
  const withCurrencies = (codes: string[], prices: object[]) => {
    const settings = initStoreSettings();
    settings.currencies = codes.map((c, i) => ({ ...settings.currencies[0], currencyCode: c, currencyIsDefault: i === 0 }));
    return {
      settings,
      categories: [category(A, true)],
      items: prices.map((p, i) => item(`item ${i}`, A, true, p)),
    };
  };

  it("keeps only the prices of currencies the store offers", () => {
    const out = toPublicInventory(withCurrencies(["USD", "CAD"], [{ USD: 6500, CAD: 8900, AUD: 9900 }]));
    expect(out.items[0].storeItemPrices).toEqual({ USD: 6500, CAD: 8900 });
  });

  it("leaves out an item with no price in any offered currency, and doesn't count it", () => {
    const out = toPublicInventory(withCurrencies(["CAD"], [{ CAD: 100 }, { USD: 100 }, {}]));
    expect(out.items.map((i) => i.storeItemName)).toEqual(["item 0"]);
    expect(out.categories[0].storeCategoryItemCount).toBe(1);
  });

  it("a free item (0) is still for sale", () => {
    expect(toPublicInventory(withCurrencies(["USD"], [{ USD: 0 }])).items).toHaveLength(1);
  });
});

describe("GET /store/inventory/get-data-public/:storeId (2.4c)", () => {
  it("a live store: 200 with only what a shopper may see", async () => {
    store({ ...initStoreSettings() });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: StoreItem) => i.storeItemName)).toEqual(["shown", "also shown"]);
    expect(res.body.categories).toHaveLength(1);
    expect(res.body.settings).not.toHaveProperty("admin");
  });

  it("an unknown store: 404 STORE_NOT_FOUND, without querying its rows", async () => {
    store(null);
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: "STORE_NOT_FOUND", message: "Store not found" });
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("a suspended store: 404 STORE_UNAVAILABLE, without querying its rows", async () => {
    store({ ...initStoreSettings(), admin: { isStoreLive: false } });
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: "STORE_UNAVAILABLE", message: "Store unavailable" });
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("settings saved before the admin block existed count as live", async () => {
    const { admin: _admin, ...legacy } = initStoreSettings();
    store(legacy);
    expect((await get()).status).toBe(200);
  });

  it("a read failure is a 500", async () => {
    ddb.on(GetCommand).rejects(new Error("throttled"));
    expect((await get()).status).toBe(500);
  });
});
