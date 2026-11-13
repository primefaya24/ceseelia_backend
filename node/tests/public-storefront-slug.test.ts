import { liveStoreSettings } from "./fixtures";
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { createApp } from "../app";
import { withShopperCurrency } from "../layers/core/http/public-storefront";
import { initStoreCategory, StoreCurrency } from "../layers/core/interfaces/store";

// Tests run as STAGE=dev, where getClientIp returns an Australian IP: the shopper's currency is AUD.
const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = ulid();
const CAT = ulid();

const currency = (code: string, isDefault: boolean): StoreCurrency => ({
  currencyCode: code,
  currencySign: "$",
  currencyFloat: "LEFT",
  currencyIsDefault: isDefault,
});

/* SLUG#northern-hoop → STORE, plus the store's SETTINGS (or none), one category and one item. */
function store(opts: { slugOwner?: string | null; settings?: Record<string, unknown> | null; codes?: string[] } = {}) {
  const { slugOwner = STORE, codes = ["USD"] } = opts;
  const settings =
    opts.settings === undefined
      ? { ...liveStoreSettings(), currencies: codes.map((c, i) => currency(c, i === 0)) }
      : opts.settings;
  ddb.on(GetCommand).callsFake((input) => {
    if (String(input.Key.pk).startsWith("SLUG#")) {
      return slugOwner ? { Item: { ...input.Key, storeId: slugOwner } } : {};
    }
    return settings ? { Item: { pk: `STORE#${STORE}`, sk: "SETTINGS", ...settings } } : {};
  });
  ddb.on(QueryCommand).callsFake((input) =>
    input.ExpressionAttributeValues[":sk_prefix"] === "CATEGORY#"
      ? { Items: [{ ...initStoreCategory(CAT, "Hoodies"), storeCategoriyId: CAT, storeCategoryIsActive: true }] }
      : {
          Items: [
            {
              storeItemId: ulid(),
              storeItemName: "Pink Slay",
              storeItemCategoryId: CAT,
              storeItemIsActive: true,
              storeItemPrices: Object.fromEntries(codes.map((c) => [c, 6500])),
            },
          ],
        }
  );
}
const get = (slug: string) => request(app).get(`/api/v1/store/public/storefront/${slug}`).set("Host", "localhost");

beforeEach(() => {
  ddb.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /store/public/storefront/:slug (3.1)", () => {
  it("returns the store's public data and its storeId", async () => {
    store();
    const res = await get("northern-hoop");
    expect(res.status).toBe(200);
    expect(res.body.storeId).toBe(STORE);
    expect(res.body.items.map((i: { storeItemName: string }) => i.storeItemName)).toEqual(["Pink Slay"]);
    expect(res.body.categories).toHaveLength(1);
    expect(res.body.settings).not.toHaveProperty("admin");
    const slugGet = ddb.commandCalls(GetCommand).find((c) => String(c.args[0].input.Key!.pk).startsWith("SLUG#"));
    expect(slugGet!.args[0].input.Key).toEqual({ pk: "SLUG#northern-hoop", sk: "STORE" });
  });

  it("looks the slug up in lower case", async () => {
    store();
    expect((await get("Northern-Hoop")).status).toBe(200);
    const slugGet = ddb.commandCalls(GetCommand).find((c) => String(c.args[0].input.Key!.pk).startsWith("SLUG#"));
    expect(slugGet!.args[0].input.Key!.pk).toBe("SLUG#northern-hoop");
  });

  it("an unknown slug: 404 STORE_NOT_FOUND, without reading any store", async () => {
    store({ slugOwner: null });
    const res = await get("no-such-store");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: "STORE_NOT_FOUND", message: "Store not found" });
    expect(ddb.commandCalls(GetCommand)).toHaveLength(1);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("a slug whose store is gone: 404 STORE_NOT_FOUND", async () => {
    store({ settings: null });
    expect((await get("northern-hoop")).body.code).toBe("STORE_NOT_FOUND");
  });

  it("a suspended store: 404 STORE_UNAVAILABLE", async () => {
    store({ settings: { ...liveStoreSettings(), admin: { suspended: true } } });
    const res = await get("northern-hoop");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("STORE_UNAVAILABLE");
  });

  it.each(["a", "-bad-", "has space", "x".repeat(41)])("an invalid slug (%s) is a 400 without a lookup", async (slug) => {
    store();
    expect((await get(encodeURIComponent(slug))).status).toBe(400);
    expect(ddb.calls()).toHaveLength(0);
  });

  it("a failed slug lookup is a 500", async () => {
    ddb.on(GetCommand).rejects(new Error("throttled"));
    expect((await get("northern-hoop")).status).toBe(500);
  });
});

describe("shopper currency (3.1 fix, both public routes)", () => {
  it("withShopperCurrency makes an offered shopper currency the default", () => {
    const out = withShopperCurrency([currency("USD", true), currency("AUD", false)], "AUD");
    expect(out.map((c) => [c.currencyCode, c.currencyIsDefault])).toEqual([
      ["USD", false],
      ["AUD", true],
    ]);
  });

  it("keeps the store's default when it doesn't offer the shopper's currency", () => {
    const list = [currency("USD", false), currency("CAD", true)];
    expect(withShopperCurrency(list, "AUD")).toEqual(list);
  });

  it("the routes: an Australian shopper at a USD-only store still gets a default (USD)", async () => {
    store({ codes: ["USD"] });
    for (const path of ["/api/v1/store/public/storefront/northern-hoop", `/api/v1/store/inventory/get-data-public/${STORE}`]) {
      const res = await request(app).get(path).set("Host", "localhost");
      expect(res.status).toBe(200);
      expect(res.body.settings.currencies).toEqual([currency("USD", true)]);
      expect(res.body.storeId).toBe(STORE);
    }
  });

  it("the routes: an Australian shopper at a USD + AUD store gets AUD", async () => {
    store({ codes: ["USD", "AUD"] });
    const res = await get("northern-hoop");
    expect(res.body.settings.currencies.find((c: StoreCurrency) => c.currencyIsDefault).currencyCode).toBe("AUD");
  });
});
