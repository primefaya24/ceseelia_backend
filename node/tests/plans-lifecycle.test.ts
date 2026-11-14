import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

import { createApp } from "../app";
import { createStore } from "../layers/aws/dynamodb/dynamo-entities/store";
import {
  initStoreSettings,
  normalizeAdminSettings,
  normalizeStoreLifecycle,
  StoreSettings,
} from "../layers/core/interfaces/store";
import {
  isStorePlan,
  PLANS,
  planFromLookupKey,
  planPriceLookupKey,
  STORE_PLANS,
  toStorePlanOrNone,
} from "../layers/core/plans";
import { liveStoreSettings } from "./fixtures";

const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = ulid();
const ITEM = ulid();

beforeEach(() => {
  ddb.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("plan catalogue (P.1)", () => {
  it("has the owner's prices and commissions; no Free plan (2026-11-13)", () => {
    expect(STORE_PLANS).toEqual(["SPARK", "NOVA"]);
    expect(PLANS).not.toHaveProperty("FREE");
    expect(PLANS.SPARK).toMatchObject({
      monthlyPriceMinor: { CAD: 2500, AUD: 2500, USD: 1900 },
      commissionMinor: { CAD: 195, AUD: 195, USD: 145 },
      customDomain: true,
    });
    expect(PLANS.NOVA).toMatchObject({
      monthlyPriceMinor: { CAD: 4900, AUD: 4900, USD: 3900 },
      commissionMinor: { CAD: 0, AUD: 0, USD: 0 },
      customDomain: true,
    });
  });

  it("can't be changed at runtime", () => {
    expect(() => {
      (PLANS.SPARK.commissionMinor as any).USD = 0;
    }).toThrow();
    expect(() => {
      (PLANS as any).SPARK = PLANS.NOVA;
    }).toThrow();
  });

  it("anything that isn't SPARK or NOVA is no plan (the old FREE too), never a plan by accident", () => {
    expect(isStorePlan("SPARK")).toBe(true);
    for (const bad of ["FREE", "NONE", "spark", "PRO", "", null, undefined, 1, ["NOVA"]]) {
      expect(isStorePlan(bad)).toBe(false);
      expect(toStorePlanOrNone(bad)).toBe("NONE");
    }
    expect(toStorePlanOrNone("NOVA")).toBe("NOVA");
  });

  it("every plan has a Stripe lookup key per currency, and back", () => {
    expect(planPriceLookupKey("SPARK", "CAD")).toBe("ceseelia_spark_cad");
    expect(planPriceLookupKey("NOVA", "USD")).toBe("ceseelia_nova_usd");
    expect(planFromLookupKey("ceseelia_nova_aud")).toEqual({ plan: "NOVA", currency: "AUD" });
    expect(planFromLookupKey("ceseelia_free_cad")).toBeNull();
    expect(planFromLookupKey("ceseelia_spark_eur")).toBeNull();
  });
});

describe("store lifecycle and suspension (P.2)", () => {
  it("a new store is a draft with no plan", () => {
    expect(initStoreSettings().lifecycle).toMatchObject({ status: "DRAFT", plan: "NONE" });
    expect(initStoreSettings().admin.suspended).toBe(false);
  });

  it("only a store with a plan is live: no lifecycle, a bad value or the old FREE never is", () => {
    expect(normalizeStoreLifecycle(undefined)).toEqual({ status: "DRAFT", plan: "NONE" });
    expect(normalizeStoreLifecycle({ status: "OPEN", plan: "GOLD" })).toEqual({
      status: "DRAFT",
      plan: "NONE",
    });
    expect(normalizeStoreLifecycle({ status: "LIVE", plan: "FREE", firstLiveAt: 5 })).toEqual({
      status: "DRAFT",
      plan: "NONE",
      firstLiveAt: 5,
      pausedReason: "PLAN_ENDED",
    });
    expect(
      normalizeStoreLifecycle({ status: "DRAFT", plan: "FREE", pausedReason: "FREE_PLAN_IN_USE" })
    ).toEqual({
      status: "DRAFT",
      plan: "NONE",
    });
    expect(normalizeStoreLifecycle({ status: "LIVE", plan: "SPARK" })).toEqual({
      status: "LIVE",
      plan: "SPARK",
    });
    expect(normalizeStoreLifecycle({ status: "IN_REVIEW", plan: "NOVA", firstLiveAt: 5 })).toEqual({
      status: "IN_REVIEW",
      plan: "NOVA",
      firstLiveAt: 5,
    });
  });

  it("reads the old isStoreLive as suspended", () => {
    expect(normalizeAdminSettings({ isStoreLive: false }).suspended).toBe(true);
    expect(normalizeAdminSettings({ isStoreLive: true }).suspended).toBe(false);
    expect(normalizeAdminSettings({}).suspended).toBe(false);
    expect(normalizeAdminSettings({ suspended: true, isStoreLive: true }).suspended).toBe(true);
    expect(normalizeAdminSettings({ suspended: false, isStoreLive: false }).suspended).toBe(false);
    expect(normalizeAdminSettings({ suspended: "yes" }).suspended).toBe(false);
  });

  it("createStore writes the new store's SETTINGS as a draft with no plan", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    await createStore("Hoop", "hoop");
    const puts = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!.map((t) => t.Put?.Item);
    const settings = puts.find((i) => i?.sk === "SETTINGS");
    expect(settings?.lifecycle).toMatchObject({ status: "DRAFT", plan: "NONE" });
    expect(settings?.admin.suspended).toBe(false);
    expect(settings?.admin).not.toHaveProperty("isStoreLive");
  });
});

describe("public routes for a store that isn't live (P.2)", () => {
  const draft = (extra: Partial<StoreSettings> = {}): StoreSettings => {
    const s = initStoreSettings();
    return {
      ...s,
      storeInfo: {
        ...s.storeInfo,
        storeName: "Hoop",
        slogan: "Soon",
        logoUri: "store/x/logo.png",
        emailaddress: "owner@hoop.test",
        phoneNumber: "+1 416 555 0142",
      },
      socialMediaLinks: { ...s.socialMediaLinks, instagram: "https://instagram.com/scam" },
      general: { ...s.general, pickupAddress: "1 Main St" },
      payments: { stripeAccountId: "acct_1", chargesEnabled: true },
      ...extra,
    };
  };
  const settingsRow = (s: StoreSettings) =>
    ddb.on(GetCommand).resolves({ Item: { pk: `STORE#${STORE}`, sk: "SETTINGS", ...s } });
  const storefront = () =>
    request(app).get(`/api/v1/store/inventory/get-data-public/${STORE}`).set("Host", "localhost");

  it.each(["DRAFT", "IN_REVIEW"] as const)(
    "%s: the storefront is a 200 'Coming soon' with nothing to buy",
    async (status) => {
      settingsRow(draft({ lifecycle: { status, plan: "NONE" } }));
      const res = await storefront();
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body.storeId).toBe(STORE);
      expect(res.body.categories).toEqual([]);
      expect(res.body.items).toEqual([]);
      const s = res.body.settings;
      expect(s.storeStatus).toBe(status);
      expect(s.paymentsEnabled).toBe(false);
      expect(s.storeInfo).toMatchObject({
        storeName: "Hoop",
        slogan: "Soon",
        logoUri: "store/x/logo.png",
      });
      expect(s.storeInfo.emailaddress).toBe("");
      expect(s.storeInfo.phoneNumber).toBe("");
      expect(s.storeInfo.contactFormAvailable).toBe(false);
      expect(s.socialMediaLinks.instagram).toBe("");
      expect(s.general.pickupAddress).toBe("");
      for (const key of ["admin", "payments", "lifecycle"]) expect(s).not.toHaveProperty(key);
      expect(ddb.commandCalls(QueryCommand)).toHaveLength(0); // its items are never read
    }
  );

  it("a suspended draft is just unavailable", async () => {
    settingsRow(draft({ admin: { ...initStoreSettings().admin, suspended: true } }));
    const res = await storefront();
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("STORE_UNAVAILABLE");
  });

  it("a live store says LIVE and never shows its lifecycle", async () => {
    settingsRow({ ...liveStoreSettings(), lifecycle: { status: "LIVE", plan: "NOVA" } });
    ddb.on(QueryCommand).resolves({ Items: [] });
    const res = await storefront();
    expect(res.status).toBe(200);
    expect(res.body.settings.storeStatus).toBe("LIVE");
    expect(res.body.settings).not.toHaveProperty("lifecycle");
  });

  it("item links, quotes and Contact us: 404 STORE_NOT_LIVE", async () => {
    settingsRow(draft());
    const item = await request(app).get(`/api/v1/store/public/item/${STORE}/${ITEM}`).set("Host", "localhost");
    expect(item.status).toBe(404);
    expect(item.body.code).toBe("STORE_NOT_LIVE");

    const quote = await request(app)
      .post("/api/v1/customer/quote")
      .set("Host", "localhost")
      .send({ storeId: STORE, currency: "USD", lines: [{ itemId: ITEM, quantity: 1 }] });
    expect(quote.status).toBe(404);
    expect(quote.body.code).toBe("STORE_NOT_LIVE");

    const contact = await request(app)
      .post("/api/v1/customer/contact-store")
      .set("Host", "localhost")
      .send({ storeId: STORE, name: "Sam", email: "sam@example.test", message: "Hi", website: "" });
    expect(contact.status).toBe(404);
    expect(contact.body.code).toBe("STORE_NOT_LIVE");
  });
});
