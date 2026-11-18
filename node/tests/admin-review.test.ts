import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

vi.mock("../layers/notifications/order-emails", () => ({
  notifyOrderPaid: vi.fn(async () => {}),
  notifyOrderStatus: vi.fn(async () => {}),
  notifyOrderRefunded: vi.fn(async () => {}),
  notifyReviewDecision: vi.fn(async () => {}),
}));
vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { lifecycleAfterReview, lifecycleWithAdminPlan } from "../layers/core/review";
import { lifecycleAfter } from "../layers/core/billing";
import { normalizeStoreLifecycle } from "../layers/core/interfaces/store";
import { createApp } from "../app";
import { notifyOrderPaid, notifyOrderRefunded, notifyOrderStatus, notifyReviewDecision } from "../layers/notifications/order-emails";

const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = "01JBZ0000000000000000000AA";
const NOW = 1_800_000_000_000;

const asAdmin = () => vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "a", "cognito:groups": ["Admins"] });
const asUser = () => vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "u", "cognito:groups": [] });
const call = (method: "get" | "post" | "put", path: string, body?: object) => {
  const r = request(app)[method](`/api/v1/admin${path}`).set("Host", "localhost").set("Authorization", "Bearer t");
  return body ? r.send(body) : r;
};
const withSettings = (item: Record<string, unknown> | null) =>
  ddb
    .on(GetCommand)
    .resolves(item ? { Item: { pk: `STORE#${STORE}`, sk: "SETTINGS", ...item } } : {});
const inReview = (requestedPlan = "SPARK", extra: object = {}) =>
  withSettings({
    lifecycle: { status: "IN_REVIEW", plan: "NONE", createdByUserId: "OWNER" },
    review: { reasons: ["X"], requestedPlan, requestedAt: 1, requestedByUserId: "OWNER" },
    ...extra,
  });
const tx = () => ddb.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];

beforeEach(() => {
  for (const fn of [notifyOrderPaid, notifyOrderStatus, notifyOrderRefunded, notifyReviewDecision]) vi.mocked(fn).mockClear();
  ddb.reset();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  asAdmin();
  ddb.on(TransactWriteCommand).resolves({});
  ddb.on(UpdateCommand).resolves({});
});

describe("review rules (P.8)", () => {
  const lc = {
    status: "IN_REVIEW" as const,
    plan: "NONE" as const,
    reviewRejection: { message: "old", at: 1 },
  };
  const opts = { now: NOW };

  it("approving never takes a store live by itself: DRAFT, cleared for Go Live (checkout next)", () => {
    expect(lifecycleAfterReview(lc, "APPROVE", opts)).toEqual({
      status: "DRAFT",
      plan: "NONE",
      statusChangedAt: NOW,
      reviewApprovedAt: NOW,
    });
    expect(
      lifecycleAfterReview({ ...lc, plan: "NOVA", planSetByAdmin: true }, "APPROVE", opts)
    ).toEqual({
      status: "DRAFT",
      plan: "NOVA",
      planSetByAdmin: true,
      statusChangedAt: NOW,
      reviewApprovedAt: NOW,
    });
  });

  it("rejecting sends it back to DRAFT with the message", () => {
    expect(lifecycleAfterReview(lc, "REJECT", { ...opts, message: "  Fake brands  " })).toEqual({
      status: "DRAFT",
      plan: "NONE",
      statusChangedAt: NOW,
      reviewRejection: { message: "Fake brands", at: NOW },
    });
  });

  it("an admin's plan is marked; NONE takes it away (a live store goes back to DRAFT); billing changing the plan clears the mark", () => {
    expect(lifecycleWithAdminPlan({ status: "DRAFT", plan: "NONE" }, "SPARK")).toEqual({
      status: "DRAFT",
      plan: "SPARK",
      planSetByAdmin: true,
    });
    expect(
      lifecycleWithAdminPlan({ status: "LIVE", plan: "SPARK", planSetByAdmin: true }, "NOVA")
    ).toEqual({ status: "LIVE", plan: "NOVA", planSetByAdmin: true });
    expect(
      lifecycleWithAdminPlan({ status: "LIVE", plan: "SPARK", planSetByAdmin: true }, "NONE", NOW)
    ).toEqual({
      status: "DRAFT",
      plan: "NONE",
      statusChangedAt: NOW,
      pausedReason: "PLAN_ENDED",
    });
    expect(
      lifecycleWithAdminPlan({ status: "DRAFT", plan: "SPARK", planSetByAdmin: true }, "NONE")
    ).toEqual({ status: "DRAFT", plan: "NONE" });
    const gifted = { status: "LIVE" as const, plan: "SPARK" as const, planSetByAdmin: true };
    expect(lifecycleAfter(gifted, { kind: "PAID", plan: "NOVA" }, opts)).toEqual({ status: "LIVE", plan: "NOVA" });
    expect(lifecycleAfter(gifted, { kind: "NONE" }, opts)).toBe(gifted);
  });

  it("the new fields survive a read; junk doesn't", () => {
    expect(
      normalizeStoreLifecycle({
        status: "DRAFT",
        plan: "SPARK",
        planSetByAdmin: true,
        reviewApprovedAt: 5,
        reviewRejection: { message: "m", at: 6 },
      })
    ).toEqual({
      status: "DRAFT",
      plan: "SPARK",
      planSetByAdmin: true,
      reviewApprovedAt: 5,
      reviewRejection: { message: "m", at: 6 },
    });
    expect(
      normalizeStoreLifecycle({
        status: "DRAFT",
        plan: "FREE",
        planSetByAdmin: "yes",
        reviewApprovedAt: "x",
        reviewRejection: { message: 5 },
      })
    ).toEqual({
      status: "DRAFT",
      plan: "NONE",
    });
  });
});

describe("GET /admin/get-review-queue (P.8)", () => {
  it("lists stores in review, oldest first, with their name and link", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        {
          storeId: "B",
          requestedAt: 20,
          requestedPlan: "SPARK",
          reasons: ["R2"],
          requestedByUserId: "U2",
        },
        { storeId: "A", requestedAt: 10, requestedPlan: "FREE", reasons: ["R1"] }, // asked before Free was dropped
      ],
    });
    ddb.on(BatchGetCommand).callsFake((input) => {
      const table = Object.keys(input.RequestItems)[0];
      return { Responses: { [table]: [{ storeId: "A", storeName: "Alpha", storeSlug: "alpha" }, { storeId: "B", storeName: "Beta", storeSlug: "beta" }] } };
    });
    const res = await call("get", "/get-review-queue");
    expect(ddb.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues).toEqual({ ":pk": "APP_REVIEW" });
    expect(res.body.stores).toEqual([
      {
        storeId: "A",
        storeName: "Alpha",
        storeSlug: "alpha",
        requestedAt: 10,
        requestedPlan: "NONE",
        reasons: ["R1"],
        requestedByUserId: null,
      },
      {
        storeId: "B",
        storeName: "Beta",
        storeSlug: "beta",
        requestedAt: 20,
        requestedPlan: "SPARK",
        reasons: ["R2"],
        requestedByUserId: "U2",
      },
    ]);
  });

  it("is admin-only", async () => {
    asUser();
    expect((await call("get", "/get-review-queue")).status).toBe(403);
  });
});

describe("POST /admin/review-store (P.8)", () => {
  it("approve: DRAFT, cleared to go live (they still pay at checkout), review answered and off the queue in one write", async () => {
    inReview();
    const res = await call("post", "/review-store", { storeId: STORE, decision: "APPROVE" });
    expect(res.body).toEqual({ status: "DRAFT", plan: "NONE", approved: true });
    const [update, queue] = tx();
    expect(update.Update!.UpdateExpression).toBe("SET #lc = :lc REMOVE #review");
    expect(update.Update!.ConditionExpression).toBe("#lc.#st = :inReview");
    expect(update.Update!.ExpressionAttributeValues![":lc"]).toMatchObject({
      status: "DRAFT",
      plan: "NONE",
      reviewApprovedAt: expect.any(Number),
      createdByUserId: "OWNER",
    });
    expect(queue.Delete!.Key).toEqual({ pk: "APP_REVIEW", sk: `STORE#${STORE}` });
    expect(notifyReviewDecision).toHaveBeenCalledWith(STORE, true, "");
  });

  it("reject: DRAFT with the reason; a reason is required", async () => {
    inReview();
    expect(
      (await call("post", "/review-store", { storeId: STORE, decision: "REJECT" })).status
    ).toBe(400);
    expect(
      (await call("post", "/review-store", { storeId: STORE, decision: "REJECT", message: "   " }))
        .status
    ).toBe(400);
    expect(
      (
        await call("post", "/review-store", {
          storeId: STORE,
          decision: "REJECT",
          message: "x".repeat(501),
        })
      ).status
    ).toBe(400);
    const res = await call("post", "/review-store", {
      storeId: STORE,
      decision: "REJECT",
      message: "Counterfeit items",
    });
    expect(res.body).toEqual({ status: "DRAFT", plan: "NONE", approved: false });
    expect(tx()[0].Update!.ExpressionAttributeValues![":lc"].reviewRejection.message).toBe(
      "Counterfeit items"
    );
  });

  it.each([[{ decision: "MAYBE" }], [{ decision: "APPROVE", storeId: "nope" }], [{ decision: 1 }]])("400 for %j", async (b) => {
    expect((await call("post", "/review-store", { storeId: STORE, ...b })).status).toBe(400);
  });

  it("409 NOT_IN_REVIEW, 409 STATUS_CHANGED when another admin decided first, 404, 403", async () => {
    withSettings({ lifecycle: { status: "LIVE", plan: "SPARK" } });
    expect(
      (await call("post", "/review-store", { storeId: STORE, decision: "APPROVE" })).body.code
    ).toBe("NOT_IN_REVIEW");
    inReview();
    ddb.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({ message: "x", $metadata: {}, CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] })
    );
    expect((await call("post", "/review-store", { storeId: STORE, decision: "APPROVE" })).body.code).toBe("STATUS_CHANGED");
    withSettings(null);
    expect((await call("post", "/review-store", { storeId: STORE, decision: "APPROVE" })).status).toBe(404);
    asUser();
    expect((await call("post", "/review-store", { storeId: STORE, decision: "APPROVE" })).status).toBe(403);
  });
});

describe("PUT /admin/set-store-plan (P.8)", () => {
  it("gives a plan without a subscription, marked as an admin's, only if nothing changed meanwhile", async () => {
    withSettings({ lifecycle: { status: "DRAFT", plan: "NONE" } });
    const res = await call("put", "/set-store-plan", { storeId: STORE, plan: "NOVA" });
    expect(res.body).toEqual({ status: "DRAFT", plan: "NOVA", planSetByAdmin: true });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues![":lc"]).toEqual({ status: "DRAFT", plan: "NOVA", planSetByAdmin: true });
    expect(input.ConditionExpression).toBe("attribute_exists(pk) AND #lc.#st = :st AND #lc.#pl = :pl AND attribute_not_exists(#sub)");
  });

  it("any plan can be given, Lumina included, and moved between plans (Q.4f)", async () => {
    for (const [from, to] of [["NONE", "LUMINA"], ["LUMINA", "SPARK"], ["SPARK", "NOVA"]]) {
      ddb.reset();
      withSettings({ lifecycle: { status: "LIVE", plan: from, ...(from === "NONE" ? {} : { planSetByAdmin: true }) } });
      expect((await call("put", "/set-store-plan", { storeId: STORE, plan: to })).body).toMatchObject({ plan: to, planSetByAdmin: true });
    }
  });

  it("NONE takes the plan away: a live store goes back to DRAFT; an ended subscription doesn't block", async () => {
    withSettings({
      lifecycle: { status: "LIVE", plan: "SPARK", planSetByAdmin: true },
      subscription: { subscriptionId: "sub_1", status: "canceled", graceEndsAt: null },
    });
    expect((await call("put", "/set-store-plan", { storeId: STORE, plan: "NONE" })).body).toEqual({
      status: "DRAFT",
      plan: "NONE",
      planSetByAdmin: false,
    });
    expect(
      ddb.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues![":lc"]
    ).toMatchObject({ status: "DRAFT", pausedReason: "PLAN_ENDED" });
    expect(ddb.commandCalls(UpdateCommand)[0].args[0].input.ConditionExpression).toContain(
      "#sub.#sid = :sid AND #sub.#subst = :subst"
    );
  });

  it("409 HAS_SUBSCRIPTION while the store pays (or is in grace); 409 STATUS_CHANGED; 400; 403", async () => {
    withSettings({
      lifecycle: { status: "LIVE", plan: "SPARK" },
      subscription: { subscriptionId: "s", status: "active", graceEndsAt: null },
    });
    expect((await call("put", "/set-store-plan", { storeId: STORE, plan: "NOVA" })).body.code).toBe(
      "HAS_SUBSCRIPTION"
    );
    withSettings({
      lifecycle: { status: "LIVE", plan: "SPARK" },
      subscription: { subscriptionId: "s", status: "unpaid", graceEndsAt: Date.now() + 1e6 },
    });
    expect((await call("put", "/set-store-plan", { storeId: STORE, plan: "NONE" })).body.code).toBe(
      "HAS_SUBSCRIPTION"
    );
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);

    withSettings({ lifecycle: { status: "DRAFT", plan: "NONE" } });
    ddb
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
    expect(
      (await call("put", "/set-store-plan", { storeId: STORE, plan: "SPARK" })).body.code
    ).toBe("STATUS_CHANGED");
    expect((await call("put", "/set-store-plan", { storeId: STORE, plan: "GOLD" })).status).toBe(
      400
    );
    expect((await call("put", "/set-store-plan", { storeId: STORE, plan: "FREE" })).status).toBe(
      400
    );
    asUser();
    expect((await call("put", "/set-store-plan", { storeId: STORE, plan: "SPARK" })).status).toBe(403);
  });
});

describe("GET /admin/get-all-stores adds status, plan and billing (P.8)", () => {
  it("merges each store's summary from its SETTINGS row, with no Stripe ids", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { pk: "APP_STORE", sk: "STORE#A#OVERVIEW", storeId: "A", storeName: "Alpha" },
        { pk: "APP_STORE", sk: "STORE#B#OVERVIEW", storeId: "B", storeName: "Beta" },
      ],
    });
    ddb.on(BatchGetCommand).callsFake((input) => {
      const table = Object.keys(input.RequestItems)[0];
      return {
        Responses: {
          [table]: [
            {
              pk: "STORE#A",
              lifecycle: { status: "LIVE", plan: "SPARK" },
              admin: { suspended: false },
              payments: { stripeAccountId: "acct_A" },
              subscription: { subscriptionId: "sub_1", customerId: "cus_1", plan: "SPARK", status: "past_due", cancelAtPeriodEnd: false, currentPeriodEnd: 9, graceEndsAt: null },
            },
          ],
        },
      };
    });
    const res = await call("get", "/get-all-stores");
    expect(res.body).toMatchObject({ total: 2, next: null });
    res.body = res.body.stores;
    expect(res.body[0]).toMatchObject({
      storeId: "A",
      status: "LIVE",
      plan: "SPARK",
      suspended: false,
      planSetByAdmin: false,
      subscription: { plan: "SPARK", status: "past_due", cancelAtPeriodEnd: false, currentPeriodEnd: 9, graceEndsAt: null },
    });
    expect(res.body[1]).toMatchObject({ storeId: "B", storeName: "Beta" });
    expect(res.body[1]).not.toHaveProperty("status"); // no SETTINGS row: overview fields only
    expect(JSON.stringify(res.body)).not.toMatch(/sub_1|cus_1|acct_A/);
    // Only the fields the summary needs are read from SETTINGS.
    expect(ddb.commandCalls(BatchGetCommand)[0].args[0].input.RequestItems![Object.keys(ddb.commandCalls(BatchGetCommand)[0].args[0].input.RequestItems!)[0]].ProjectionExpression).toContain("lifecycle");
  });

  it("L.9: pages and searches", async () => {
    ddb.on(QueryCommand).resolves({
      Items: Array.from({ length: 7 }, (_, i) => ({
        pk: "APP_STORE",
        sk: `STORE#S${i}#OVERVIEW`,
        storeId: `S${i}`,
        storeName: i === 5 ? "Tea House" : `Store ${i}`,
        storeSlug: `store-${i}`,
        storeOrderLastCompletedTimestamp: i,
      })),
    });
    ddb.on(BatchGetCommand).callsFake((input) => ({ Responses: { [Object.keys(input.RequestItems)[0]]: [] } }));
    const first = await call("get", "/get-all-stores?limit=3");
    expect(first.body.stores.map((s: { storeId: string }) => s.storeId)).toEqual(["S6", "S5", "S4"]);
    expect(first.body).toMatchObject({ next: "3", total: 7 });
    const last = await call("get", "/get-all-stores?limit=3&cursor=6");
    expect(last.body).toMatchObject({ next: null, total: 7 });
    expect(last.body.stores).toHaveLength(1);
    const tea = await call("get", "/get-all-stores?q=TEA");
    expect(tea.body.stores.map((s: { storeId: string }) => s.storeId)).toEqual(["S5"]);
    expect((await call("get", "/get-all-stores?limit=abc")).status).toBe(400);
  });

  it("UX-D: filters by status, past due and hidden items, with a count per filter", async () => {
    const ids = ["L", "R", "D", "S", "P", "H"];
    ddb.on(QueryCommand).callsFake((input) =>
      input.ExpressionAttributeValues[":pk"] === "APP_STORE"
        ? { Items: ids.map((id) => ({ pk: "APP_STORE", sk: `STORE#${id}#OVERVIEW`, storeId: id, storeName: `Store ${id}` })) }
        : { Items: [{ storeId: "H", itemId: "i1", flaggedAt: 1 }, { storeId: "H", itemId: "i2", flaggedAt: 2 }] }
    );
    const sub = (status: string) => ({ subscriptionId: "s", customerId: "c", plan: "SPARK", status, cancelAtPeriodEnd: false, currentPeriodEnd: 9, graceEndsAt: null });
    const rows: Record<string, object> = {
      L: { lifecycle: { status: "LIVE", plan: "SPARK" }, subscription: sub("active") },
      R: { lifecycle: { status: "IN_REVIEW", plan: "NONE" } },
      D: { lifecycle: { status: "DRAFT", plan: "NONE" } },
      S: { lifecycle: { status: "LIVE", plan: "NOVA" }, admin: { suspended: true } },
      P: { lifecycle: { status: "LIVE", plan: "SPARK" }, subscription: sub("past_due") },
      H: { lifecycle: { status: "LIVE", plan: "NOVA" } },
    };
    ddb.on(BatchGetCommand).callsFake((input) => {
      const table = Object.keys(input.RequestItems)[0];
      const keys = input.RequestItems[table].Keys as { pk: string }[];
      return { Responses: { [table]: keys.map((k) => ({ pk: k.pk, ...rows[k.pk.slice(6)] })) } };
    });
    const got = async (filter: string) => (await call("get", `/get-all-stores?filter=${filter}`)).body;
    const all = await got("all");
    expect(all.counts).toEqual({ all: 6, "in-review": 1, items: 1, "past-due": 1, live: 3, draft: 1, suspended: 1 });
    const only = async (filter: string) => (await got(filter)).stores.map((s: { storeId: string }) => s.storeId).sort();
    expect(await only("in-review")).toEqual(["R"]);
    expect(await only("items")).toEqual(["H"]);
    expect(await only("past-due")).toEqual(["P"]);
    expect(await only("live")).toEqual(["H", "L", "P"]);
    expect(await only("draft")).toEqual(["D"]);
    expect(await only("suspended")).toEqual(["S"]);
    expect((await got("past-due")).total).toBe(1);
    expect((await call("get", "/get-all-stores?filter=nope")).status).toBe(400);
  });
});
