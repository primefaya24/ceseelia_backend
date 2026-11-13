import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  findUserIdByCognitoId: vi.fn(async () => "USER1"),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getMembership: vi.fn(),
  findLiveFreeStoreAdministeredBy: vi.fn(async () => null),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/store", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/store")>()),
  getStoreInventoryData: vi.fn(),
}));
vi.mock("../layers/payments/account-status", async (orig) => ({
  ...(await orig<typeof import("../layers/payments/account-status")>()),
  readStoreStripeAccount: vi.fn(),
}));
vi.mock("../layers/core/store-validation", async (orig) => ({
  ...(await orig<typeof import("../layers/core/store-validation")>()),
  runSmartStoreValidation: vi.fn(async () => ({ ok: true })),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { findLiveFreeStoreAdministeredBy, getMembership } from "../layers/aws/dynamodb/dynamo-entities/membership";
import { createStore, getStoreInventoryData, withoutAdminSettings } from "../layers/aws/dynamodb/dynamo-entities/store";
import { readStoreStripeAccount } from "../layers/payments/account-status";
import { runSmartStoreValidation } from "../layers/core/store-validation";
import { billingCurrencyFor, goLiveChecklist } from "../layers/core/go-live";
import { initStoreCategory, initStoreSettings, StoreInventoryData, StoreItem } from "../layers/core/interfaces/store";
import { planOptions } from "../api/v1/store/go-live/shared";
import { setPaidPlansEnabledForTests } from "../layers/core/plans";
import { createApp } from "../app";

const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = "01JBZ0000000000000000000AA";
const CAT = ulid();

/** A draft that has everything Go Live needs. */
function readyStore(patch: (d: StoreInventoryData) => void = () => {}): StoreInventoryData {
  const s = initStoreSettings();
  const data: StoreInventoryData = {
    settings: {
      ...s,
      storeInfo: { ...s.storeInfo, storeName: "Northern Hoop" },
      general: { ...s.general, pickupEnabled: true, pickupAddress: "1 Main St" },
      lifecycle: { status: "DRAFT", plan: "FREE" },
    },
    categories: [{ ...initStoreCategory(CAT, "Hoops"), storeCategoriyId: CAT, storeCategoryIsActive: true }],
    items: [
      {
        storeItemId: ulid(),
        storeItemName: "Hoop",
        storeItemCategoryId: CAT,
        storeItemIsActive: true,
        storeItemPrices: { [s.currencies[0].currencyCode]: 2500 },
      } as StoreItem,
    ],
  };
  patch(data);
  return data;
}
const stripeOk = (country = "CA") =>
  vi.mocked(readStoreStripeAccount).mockResolvedValue({
    connected: true,
    account: { country } as any,
    chargesEnabled: true,
    payoutsEnabled: true,
    detailsSubmitted: true,
  });
const asRole = (role: "ADMIN" | "MERCHANT" | null) => {
  vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "c1", "cognito:groups": [] });
  vi.mocked(getMembership).mockResolvedValue(role ? { storeId: STORE, userId: "USER1", role, createdAt: 1 } : null);
};
const asPlatformAdmin = () =>
  vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "a1", "cognito:groups": ["Admins"] });
const goLive = (body: object) =>
  request(app).post("/api/v1/store/go-live").set("Host", "localhost").set("Authorization", "Bearer t").send(body);
const checklist = () =>
  request(app).get(`/api/v1/store/go-live/checklist/${STORE}`).set("Host", "localhost").set("Authorization", "Bearer t");
const written = () => ddb.commandCalls(UpdateCommand)[0]?.args[0].input;
/** IN_REVIEW is a transaction (P.8): the SETTINGS update, then the review queue row. */
const reviewTx = () => ddb.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];

beforeEach(() => {
  ddb.reset();
  setPaidPlansEnabledForTests(true);
  vi.mocked(getStoreInventoryData).mockReset().mockResolvedValue(readyStore());
  vi.mocked(findLiveFreeStoreAdministeredBy).mockReset().mockResolvedValue(null);
  vi.mocked(runSmartStoreValidation).mockReset().mockResolvedValue({ ok: true });
  stripeOk();
  asRole("ADMIN");
  ddb.on(UpdateCommand).resolves({});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("goLiveChecklist (P.4a)", () => {
  const ids = (d: StoreInventoryData, chargesEnabled = true) =>
    goLiveChecklist(d, { chargesEnabled }).filter((s) => !s.ok).map((s) => s.id);

  it("a ready store passes every step", () => {
    expect(goLiveChecklist(readyStore(), { chargesEnabled: true }).every((s) => s.ok && s.message === "")).toBe(true);
  });

  it("needs a name, a buyable item, a way to get orders and payments", () => {
    expect(ids(readyStore((d) => (d.settings.storeInfo.storeName = "  ")))).toEqual(["STORE_NAME"]);
    expect(ids(readyStore((d) => (d.items[0].storeItemIsActive = false)))).toEqual(["ITEMS"]);
    expect(ids(readyStore((d) => (d.categories[0].storeCategoryIsActive = false)))).toEqual(["ITEMS"]);
    expect(ids(readyStore((d) => (d.items[0].storeItemPrices = { EUR: 100 } as any)))).toEqual(["ITEMS"]);
    expect(ids(readyStore(), false)).toEqual(["PAYMENTS"]);
  });

  it("pickup needs an address; delivery alone is fine", () => {
    const noAddress = readyStore((d) => (d.settings.general.pickupAddress = ""));
    expect(ids(noAddress)).toEqual(["FULFILMENT"]);
    expect(goLiveChecklist(noAddress, { chargesEnabled: true }).find((s) => s.id === "FULFILMENT")!.message).toContain(
      "pickup address"
    );
    const deliveryOnly = readyStore((d) => {
      d.settings.general = { ...d.settings.general, pickupEnabled: false, pickupAddress: "", deliveryEnabled: true };
    });
    expect(ids(deliveryOnly)).toEqual([]);
  });

  it("bills in the Stripe country's currency (A1)", () => {
    expect(billingCurrencyFor("CA")).toBe("CAD");
    expect(billingCurrencyFor("us")).toBe("USD");
    expect(billingCurrencyFor("AU")).toBe("AUD");
    expect(billingCurrencyFor("GB")).toBeNull();
    expect(billingCurrencyFor(null)).toBeNull();
  });

  it("plan options: paid plans only when switched on, FREE can be in use, prices in the billing currency", () => {
    setPaidPlansEnabledForTests(false);
    const opts = planOptions("USD", true);
    expect(opts.map((o) => [o.id, o.available, o.unavailableReason])).toEqual([
      ["FREE", false, "FREE_PLAN_IN_USE"],
      ["SPARK", false, "PLAN_NOT_AVAILABLE"],
      ["NOVA", false, "PLAN_NOT_AVAILABLE"],
    ]);
    expect(opts[1]).toMatchObject({ monthlyPriceMinor: 1900, commissionMinor: 145 });
    expect(planOptions(null, false)[0]).toMatchObject({ available: true, monthlyPriceMinor: null, commissionMinor: null });
    setPaidPlansEnabledForTests(true);
    expect(planOptions("CAD", false).map((o) => o.available)).toEqual([true, true, true]);
  });
});

describe("runSmartStoreValidation (P.4c)", () => {
  it("is a TODO stub that passes every store for now", async () => {
    const real = await vi.importActual<typeof import("../layers/core/store-validation")>("../layers/core/store-validation");
    expect(await real.runSmartStoreValidation({ storeId: STORE, data: readyStore() })).toEqual({ ok: true });
  });
});

describe("POST /store/go-live (P.4b)", () => {
  it("a ready draft on FREE goes LIVE, only if it's still a draft", async () => {
    const res = await goLive({ storeId: STORE, plan: "FREE" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "LIVE", plan: "FREE" });
    expect(runSmartStoreValidation).toHaveBeenCalledWith({ storeId: STORE, data: expect.any(Object) });
    const input = written();
    expect(input.Key).toEqual({ pk: `STORE#${STORE}`, sk: "SETTINGS" });
    expect(input.ConditionExpression).toBe("#lc.#st = :draft");
    expect(input.UpdateExpression).toBe("SET #lc = :lc REMOVE #review");
    expect(input.ExpressionAttributeValues![":lc"]).toMatchObject({ status: "LIVE", plan: "FREE" });
    expect(input.ExpressionAttributeValues![":lc"].firstLiveAt).toBeGreaterThan(0);
  });

  it("store MERCHANTs and non-members can't; a platform admin can (and skips the one-FREE rule)", async () => {
    asRole("MERCHANT");
    expect((await goLive({ storeId: STORE, plan: "FREE" })).status).toBe(403);
    asRole(null);
    expect((await goLive({ storeId: STORE, plan: "FREE" })).status).toBe(403);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);

    asPlatformAdmin();
    vi.mocked(findLiveFreeStoreAdministeredBy).mockResolvedValue("OTHER");
    expect((await goLive({ storeId: STORE, plan: "FREE" })).body.status).toBe("LIVE");
    expect(findLiveFreeStoreAdministeredBy).not.toHaveBeenCalled();
  });

  it.each([[{ storeId: STORE }], [{ storeId: STORE, plan: "GOLD" }], [{ storeId: STORE, plan: 1 }], [{ storeId: "x", plan: "FREE" }]])(
    "400 for %j",
    async (body) => {
      expect((await goLive(body)).status).toBe(400);
    }
  );

  it.each([
    ["STORE_SUSPENDED", (d: StoreInventoryData) => (d.settings.admin = { ...d.settings.admin, suspended: true })],
    ["ALREADY_LIVE", (d: StoreInventoryData) => (d.settings.lifecycle = { status: "LIVE", plan: "FREE" })],
    ["IN_REVIEW", (d: StoreInventoryData) => (d.settings.lifecycle = { status: "IN_REVIEW", plan: "FREE" })],
  ])("409 %s", async (code, patch) => {
    vi.mocked(getStoreInventoryData).mockResolvedValue(readyStore(patch));
    const res = await goLive({ storeId: STORE, plan: "FREE" });
    expect([res.status, res.body.code]).toEqual([409, code]);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("409 PLAN_NOT_AVAILABLE for paid plans while they're switched off", async () => {
    setPaidPlansEnabledForTests(false);
    for (const plan of ["SPARK", "NOVA"]) {
      const res = await goLive({ storeId: STORE, plan });
      expect([res.status, res.body.code]).toEqual([409, "PLAN_NOT_AVAILABLE"]);
    }
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("409 CHECKLIST_INCOMPLETE re-checked on the server, Stripe included", async () => {
    vi.mocked(readStoreStripeAccount).mockResolvedValue({ connected: false, disconnected: false });
    const res = await goLive({ storeId: STORE, plan: "FREE" });
    expect([res.status, res.body.code]).toEqual([409, "CHECKLIST_INCOMPLETE"]);
    expect(res.body.steps.find((s: { id: string }) => s.id === "PAYMENTS").ok).toBe(false);
    expect(runSmartStoreValidation).not.toHaveBeenCalled();
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("409 FREE_PLAN_IN_USE when the caller already has a live FREE store", async () => {
    vi.mocked(findLiveFreeStoreAdministeredBy).mockResolvedValue("OTHER_STORE");
    const res = await goLive({ storeId: STORE, plan: "FREE" });
    expect([res.status, res.body.code]).toEqual([409, "FREE_PLAN_IN_USE"]);
    expect(findLiveFreeStoreAdministeredBy).toHaveBeenCalledWith("USER1", STORE);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("flagged by validation → IN_REVIEW, with the reasons kept for admins", async () => {
    vi.mocked(runSmartStoreValidation).mockResolvedValue({ ok: false, reasons: ["Counterfeit brand names"] });
    const res = await goLive({ storeId: STORE, plan: "FREE" });
    expect(res.body).toEqual({ status: "IN_REVIEW", plan: "FREE" });
    expect(res.body).not.toHaveProperty("reasons");
    const [update, queue] = reviewTx();
    const input = update.Update!;
    expect(input.UpdateExpression).toBe("SET #lc = :lc, #review = :review");
    expect(input.ConditionExpression).toBe("#lc.#st = :draft");
    expect(queue.Put!.Item).toMatchObject({ pk: "APP_REVIEW", sk: `STORE#${STORE}`, storeId: STORE, requestedPlan: "FREE" });
    expect(input.ExpressionAttributeValues![":review"]).toMatchObject({
      reasons: ["Counterfeit brand names"],
      requestedPlan: "FREE",
      requestedByUserId: "USER1",
    });
    expect(input.ExpressionAttributeValues![":lc"]).not.toHaveProperty("firstLiveAt");
  });

  it("a validation that throws fails closed: IN_REVIEW, never LIVE", async () => {
    vi.mocked(runSmartStoreValidation).mockRejectedValue(new Error("AI down"));
    const res = await goLive({ storeId: STORE, plan: "FREE" });
    expect(res.body.status).toBe("IN_REVIEW");
    expect(reviewTx()[0].Update!.ExpressionAttributeValues![":review"].reasons).toEqual(["VALIDATION_UNAVAILABLE"]);
  });

  it("409 STATUS_CHANGED when the store left DRAFT meanwhile", async () => {
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "no", $metadata: {} }));
    const res = await goLive({ storeId: STORE, plan: "FREE" });
    expect([res.status, res.body.code]).toEqual([409, "STATUS_CHANGED"]);
  });
});

describe("GET /store/go-live/checklist/:storeId (P.4a)", () => {
  it("members see the steps, plans in the billing currency and whether they can go live", async () => {
    setPaidPlansEnabledForTests(false);
    asRole("MERCHANT");
    vi.mocked(getStoreInventoryData).mockResolvedValue(readyStore((d) => (d.items = [])));
    const res = await checklist();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "DRAFT", plan: "FREE", suspended: false, canGoLive: false, ready: false });
    expect(res.body.steps.filter((s: { ok: boolean }) => !s.ok).map((s: { id: string }) => s.id)).toEqual(["ITEMS"]);
    expect(res.body.billingCurrency).toBe("CAD");
    expect(res.body.plans[0]).toMatchObject({ id: "FREE", available: true, commissionMinor: 295 });
    expect(res.body.plans[1]).toMatchObject({ id: "SPARK", monthlyPriceMinor: 2500, available: false });
  });

  it("store ADMINs can go live; FREE shows as in use when it is", async () => {
    vi.mocked(findLiveFreeStoreAdministeredBy).mockResolvedValue("OTHER");
    const res = await checklist();
    expect(res.body).toMatchObject({ canGoLive: true, ready: true });
    expect(res.body.plans[0]).toMatchObject({ available: false, unavailableReason: "FREE_PLAN_IN_USE" });
  });

  it("non-members can't see it", async () => {
    asRole(null);
    expect((await checklist()).status).toBe(403);
  });
});

describe("P.4 data rules", () => {
  it("members' data never includes the admin-only review", () => {
    const d = readyStore();
    d.settings.review = { reasons: ["x"], requestedPlan: "FREE", requestedAt: 1, requestedByUserId: "U" };
    expect(withoutAdminSettings(d).settings).not.toHaveProperty("review");
  });

  it("a new store starts with its name in Store info, so the checklist's first step is done", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    await createStore("Northern Hoop", "northern-hoop");
    const settings = ddb
      .commandCalls(TransactWriteCommand)[0]
      .args[0].input.TransactItems!.map((t) => t.Put?.Item)
      .find((i) => i?.sk === "SETTINGS");
    expect(settings?.storeInfo.storeName).toBe("Northern Hoop");
  });

  it("GET /store/public/plans lists the catalogue with availability, no sign-in", async () => {
    setPaidPlansEnabledForTests(false);
    const res = await request(app).get("/api/v1/store/public/plans").set("Host", "localhost");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    expect(res.body.plans.map((p: { id: string; available: boolean }) => [p.id, p.available])).toEqual([
      ["FREE", true],
      ["SPARK", false],
      ["NOVA", false],
    ]);
    expect(res.body.plans[2].monthlyPriceMinor).toEqual({ CAD: 4900, AUD: 4900, USD: 3900 });
  });
});

describe("Go Live after an admin's review or plan (P.8)", () => {
  it("a store an admin approved skips the check", async () => {
    vi.mocked(getStoreInventoryData).mockResolvedValue(
      readyStore((d) => (d.settings.lifecycle = { status: "DRAFT", plan: "FREE", reviewApprovedAt: 1, reviewRejection: { message: "m", at: 0 } }))
    );
    const res = await goLive({ storeId: STORE, plan: "FREE" });
    expect(res.body).toEqual({ status: "LIVE", plan: "FREE" });
    expect(runSmartStoreValidation).not.toHaveBeenCalled();
    const lc = written().ExpressionAttributeValues![":lc"];
    expect(lc).not.toHaveProperty("reviewApprovedAt");
    expect(lc).not.toHaveProperty("reviewRejection");
  });

  it("a plan an admin gave goes live without a checkout, even with paid plans off", async () => {
    setPaidPlansEnabledForTests(false);
    vi.mocked(getStoreInventoryData).mockResolvedValue(
      readyStore((d) => (d.settings.lifecycle = { status: "DRAFT", plan: "NOVA", planSetByAdmin: true }))
    );
    const res = await goLive({ storeId: STORE, plan: "NOVA" });
    expect(res.body).toEqual({ status: "LIVE", plan: "NOVA" });
    expect(written().ExpressionAttributeValues![":lc"]).toMatchObject({ plan: "NOVA", planSetByAdmin: true });
    // Any other paid plan is still refused while they're off.
    vi.mocked(getStoreInventoryData).mockResolvedValue(
      readyStore((d) => (d.settings.lifecycle = { status: "DRAFT", plan: "NOVA", planSetByAdmin: true }))
    );
    expect((await goLive({ storeId: STORE, plan: "SPARK" })).body.code).toBe("PLAN_NOT_AVAILABLE");
  });

  it("the checklist tells the merchant about a rejection, an approval and a gifted plan", async () => {
    setPaidPlansEnabledForTests(false);
    vi.mocked(getStoreInventoryData).mockResolvedValue(
      readyStore(
        (d) =>
          (d.settings.lifecycle = { status: "DRAFT", plan: "SPARK", planSetByAdmin: true, reviewRejection: { message: "Fix X", at: 2 } })
      )
    );
    const res = await checklist();
    expect(res.body).toMatchObject({ reviewRejection: { message: "Fix X", at: 2 }, reviewApproved: false, giftedPlan: "SPARK" });
    expect(res.body.plans.find((p: { id: string }) => p.id === "SPARK")).toMatchObject({ available: true, unavailableReason: null });
    expect(res.body.plans.find((p: { id: string }) => p.id === "NOVA").available).toBe(false);
  });
});
