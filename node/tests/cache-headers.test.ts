import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { ulid } from "ulid";

import { createApp } from "../app";
import { contactLimits } from "../api/v1/customer/contact-store";
import { initStoreCategory, initStoreSettings } from "../layers/core/interfaces/store";

const ddb = mockClient(DynamoDBDocumentClient);
const ses = mockClient(SESClient);
const app = createApp();
const STORE = ulid();
const CAT = ulid();
const ITEM = ulid();
const get = (path: string) => request(app).get(`/api/v1${path}`).set("Host", "localhost");

function liveStore() {
  const settings = { ...initStoreSettings(), storeInfo: { ...initStoreSettings().storeInfo, emailaddress: "o@x.test" } };
  const item = { storeItemId: ITEM, storeItemName: "Tea", storeItemCategoryId: CAT, storeItemIsActive: true, storeItemPrices: { USD: 100 } };
  const category = { ...initStoreCategory(CAT, "Drinks"), storeCategoriyId: CAT, storeCategoryIsActive: true };
  ddb.on(GetCommand).callsFake((input) => {
    const { pk, sk } = input.Key as { pk: string; sk: string };
    if (pk.startsWith("SLUG#")) return { Item: { ...input.Key, storeId: STORE } };
    if (sk === "SETTINGS") return { Item: { ...input.Key, ...settings } };
    if (sk.startsWith("ITEM#")) return { Item: { ...input.Key, ...item } };
    if (sk.startsWith("CATEGORY#")) return { Item: { ...input.Key, ...category } };
    return {};
  });
  ddb.on(QueryCommand).callsFake((input) =>
    input.ExpressionAttributeValues[":sk_prefix"] === "CATEGORY#" ? { Items: [category] } : { Items: [item] }
  );
}

beforeEach(() => {
  ddb.reset();
  ses.reset();
  ses.on(SendEmailCommand).resolves({ MessageId: "m" });
  contactLimits.perIp.reset();
  contactLimits.perStore.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("Cache-Control on public endpoints (3.2)", () => {
  it.each([
    ["the storefront by slug", "/store/public/storefront/northern-hoop"],
    ["the storefront by id", `/store/inventory/get-data-public/${STORE}`],
    ["an item", `/store/public/item/${STORE}/${ITEM}`],
  ])("%s is private (it varies by shopper currency), 30 s, with an ETag", async (_n, path) => {
    liveStore();
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, max-age=30");
    expect(res.headers.etag).toBeTruthy();
  });

  it("a matching If-None-Match gets a 304 with no body", async () => {
    liveStore();
    const first = await get("/store/public/storefront/northern-hoop");
    const again = await get("/store/public/storefront/northern-hoop").set("If-None-Match", first.headers.etag);
    expect(again.status).toBe(304);
    expect(again.text).toBe("");
  });

  it("a slug lookup is public for 5 minutes", async () => {
    liveStore();
    expect((await get("/store/public/resolve-slug/northern-hoop")).headers["cache-control"]).toBe("public, max-age=300");
  });

  it.each([
    ["an unknown store", () => ddb.on(GetCommand).resolves({}), `/store/inventory/get-data-public/${STORE}`],
    ["an unknown slug", () => ddb.on(GetCommand).resolves({}), "/store/public/resolve-slug/nope-nope"],
    ["an unknown slug (storefront)", () => ddb.on(GetCommand).resolves({}), "/store/public/storefront/nope-nope"],
    ["a missing item", () => {
      liveStore();
      ddb.on(GetCommand).callsFake((input) =>
        (input.Key as { sk: string }).sk === "SETTINGS" ? { Item: { ...input.Key, ...initStoreSettings() } } : {}
      );
    }, `/store/public/item/${STORE}/${ITEM}`],
    ["a server error", () => ddb.on(GetCommand).rejects(new Error("x")), `/store/inventory/get-data-public/${STORE}`],
  ])("%s is never cached", async (_n, arrange, path) => {
    arrange();
    const res = await get(path);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("contact-store is never cached", async () => {
    liveStore();
    const res = await request(app)
      .post("/api/v1/customer/contact-store")
      .set("Host", "localhost")
      .send({ storeId: STORE, name: "Sam", email: "s@x.test", message: "Hi" });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
