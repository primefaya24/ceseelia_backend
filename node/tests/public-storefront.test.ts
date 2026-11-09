import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { createApp } from "../app";
import { toPublicInventory } from "../layers/aws/dynamodb/dynamo-entities/store";
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
const item = (name: string, categoryId: string, active = true) =>
  ({ storeItemId: ulid(), storeItemName: name, storeItemCategoryId: categoryId, storeItemIsActive: active }) as StoreItem;

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
    store({ ...initStoreSettings(), admin: { salesCommission: 1, isStoreLive: false } });
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
