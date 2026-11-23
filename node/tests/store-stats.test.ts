import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  findUserIdByCognitoId: vi.fn(async () => "USER1"),
  fetchUserUUID: vi.fn(async () => "USER1"),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getMembership: vi.fn(async (s: string, u: string) => ({ storeId: s, userId: u, role: "MERCHANT", createdAt: 1 })),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";
import { buildActivity, computeStoreOverview, isTimeZone, StatsOrder, statsWindowStart, toRangeDays } from "../layers/core/store-stats";
import { forgetStoreOverview } from "../layers/core/store-stats/overview-cache";
import { listStatsOrders } from "../layers/aws/dynamodb/dynamo-entities/order";
import { resetOverviewCacheForTests } from "../api/v1/store/overview/index";

const ddb = mockClient(DynamoDBDocumentClient);
const STORE = "01JBZ0000000000000000000AA";
const TZ = "America/Toronto";
// Sun 2026-11-15 15:00 in Toronto (EST, UTC-5) = 20:00 UTC.
const NOW = Date.UTC(2026, 10, 15, 20, 0);
const H = 3600_000;
const D = 24 * H;

const line = (itemId: string, quantity: number, totalMinor: number, itemName = `Item ${itemId}`) => ({
  itemId, itemName, quantity, params: [], unitPriceMinor: 0, discountPercent: 0, subtotalMinor: totalMinor, discountMinor: 0, totalMinor,
});
const o = (paidAt: number | undefined, over: Partial<StatsOrder> = {}): StatsOrder => ({
  storeOrderStatus: "PAID",
  storeOrderPaidAt: paidAt,
  storeOrderTotalMinor: 1000,
  storeOrderCurrency: "CAD",
  storeOrderLines: [line("A", 1, 900)],
  ...over,
});

describe("computeStoreOverview (L.6)", () => {
  it("today starts at the merchant's midnight, not UTC's", () => {
    // 23:30 Toronto yesterday = 04:30 UTC today: yesterday for the merchant.
    const s = computeStoreOverview([o(Date.UTC(2026, 10, 15, 4, 30)), o(Date.UTC(2026, 10, 15, 5, 30))], NOW, TZ);
    expect(s.today.orders).toBe(1);
    expect(s.last7.orders).toBe(2);
    expect(s.days.map((d) => d.date)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
    expect(s.days[5].orders).toBe(1);
    expect(s.days[6].orders).toBe(1);
  });

  it("only paid orders count; refunds come off sales; a fully refunded order isn't an order", () => {
    const s = computeStoreOverview(
      [
        o(NOW - H),
        o(NOW - H, { storeOrderRefundedMinor: 400 }),
        o(NOW - H, { storeOrderStatus: "REFUNDED", storeOrderRefundedMinor: 1000 }),
        o(NOW - H, { storeOrderStatus: "CANCELLED" }),
        o(undefined, { storeOrderStatus: "PENDING_PAYMENT" }),
        o(NOW + H), // clock skew: not yet
      ],
      NOW,
      TZ
    );
    expect(s.today).toEqual({ orders: 2, sales: [{ currency: "CAD", minor: 1600 }], averageOrder: [{ currency: "CAD", minor: 800 }] });
  });

  it("currencies are never added together; the bigger one leads", () => {
    const s = computeStoreOverview([o(NOW - H), o(NOW - H, { storeOrderCurrency: "USD", storeOrderTotalMinor: 5000 })], NOW, TZ);
    expect(s.today.sales).toEqual([{ currency: "USD", minor: 5000 }, { currency: "CAD", minor: 1000 }]);
    expect(s.today.averageOrder).toEqual([{ currency: "USD", minor: 5000 }, { currency: "CAD", minor: 1000 }]);
  });

  it("splits the last 7 days from the 7 before", () => {
    const s = computeStoreOverview([o(NOW - 3 * D), o(NOW - 8 * D), o(NOW - 9 * D), o(NOW - 20 * D)], NOW, TZ);
    expect(s.last7.orders).toBe(1);
    expect(s.previous7.orders).toBe(2);
  });

  it("best sellers: units over 30 days, top 5, newest name, no refunded orders", () => {
    const orders = [
      o(NOW - 2 * D, { storeOrderLines: [line("A", 3, 3000, "Old name"), line("B", 1, 500)] }),
      o(NOW - H, { storeOrderLines: [line("A", 1, 1000, "New name"), line("C", 2, 800)] }),
      o(NOW - H, { storeOrderStatus: "REFUNDED", storeOrderRefundedMinor: 1000, storeOrderLines: [line("B", 50, 1)] }),
      o(NOW - 40 * D, { storeOrderLines: [line("D", 99, 1)] }),
      ...["E", "F", "G", "H"].map((id) => o(NOW - D, { storeOrderLines: [line(id, 1, 100)] })),
    ];
    const s = computeStoreOverview(orders, NOW, TZ);
    expect(s.bestSellers).toHaveLength(5);
    expect(s.bestSellers[0]).toEqual({ itemId: "A", itemName: "New name", quantity: 4, sales: [{ currency: "CAD", minor: 4000 }] });
    expect(s.bestSellers[1].itemId).toBe("C");
    expect(s.bestSellers.map((b) => b.itemId)).not.toContain("D");
  });

  it("an empty store is all zeros with seven empty days", () => {
    const s = computeStoreOverview([], NOW, TZ);
    expect(s.today).toEqual({ orders: 0, sales: [], averageOrder: [] });
    expect(s.days).toHaveLength(7);
    expect(s.bestSellers).toEqual([]);
  });

  it("a range: the asked days, the same days before, and best sellers over it", () => {
    const orders = [o(NOW - 2 * D), o(NOW - 20 * D), o(NOW - 40 * D), o(NOW - 70 * D)];
    const s = computeStoreOverview(orders, NOW, TZ, false, { rangeDays: 30, bestSellerDays: 30 });
    expect(s.rangeDays).toBe(30);
    expect(s.days).toHaveLength(30);
    expect(s.days[29].date).toBe("2026-11-15");
    expect(s.current.orders).toBe(2);
    expect(s.previous.orders).toBe(1);
    // The 7-day numbers stay for older webapps.
    expect(s.last7.orders).toBe(1);
    expect(s.bestSellers[0].quantity).toBe(2);
    const q = computeStoreOverview(orders, NOW, TZ, false, { rangeDays: 90, bestSellerDays: 90 });
    expect(q.current.orders).toBe(4);
    expect(q.bestSellers[0].quantity).toBe(4);
  });

  it("recent orders (newest first, refunded ones left out) and orders still to do", () => {
    const orders = [
      o(NOW - 3 * H, { storeOrderId: "O1", storeOrderCode: "PB-1001", storeOrderType: "PICKUP", storeOrderStatus: "COMPLETED" }),
      o(NOW - 1 * H, { storeOrderId: "O2", storeOrderCode: "PB-1002", storeOrderType: "DELIVERY", storeOrderRefundedMinor: 400 }),
      o(NOW - 2 * H, { storeOrderId: "O3", storeOrderStatus: "REFUNDED" }),
      o(NOW - 4 * H, { storeOrderId: "O4", storeOrderStatus: "READY" }),
      o(undefined, { storeOrderId: "O5", storeOrderStatus: "PENDING_PAYMENT" }),
    ];
    const s = computeStoreOverview(orders, NOW, TZ);
    expect(s.recentOrders.map((r) => r.orderId)).toEqual(["O2", "O1", "O4"]);
    expect(s.recentOrders[0]).toEqual({ orderId: "O2", code: "PB-1002", totalMinor: 600, currency: "CAD", type: "DELIVERY", paidAt: NOW - H });
    expect(s.ordersToDo).toBe(2);
  });

  it("buildActivity mixes orders, reviews and messages, newest first, and shortens long text", () => {
    const a = buildActivity(
      [{ orderId: "O1", code: "PB-1", totalMinor: 500, currency: "CAD", type: "PICKUP", paidAt: 30 }],
      [{ createdAt: 20, rating: 5, comment: "x".repeat(200), authorName: "Ann L." }],
      [{ conversationId: "C1", lastAt: 40, customerName: "Bo", preview: "Hi" }],
      2
    );
    expect(a.map((x) => x.kind)).toEqual(["message", "order"]);
    const r = buildActivity([], [{ createdAt: 1, rating: 4, comment: "y".repeat(200), authorName: "Z" }], []);
    expect(r[0].kind === "review" && r[0].comment.length).toBe(120);
  });

  it("toRangeDays and the read window", () => {
    expect(toRangeDays("7")).toBe(7);
    expect(toRangeDays("90")).toBe(90);
    expect(toRangeDays("14")).toBeNull();
    expect(toRangeDays(30)).toBeNull();
    const day = 24 * 3600 * 1000;
    // 90 days and the 90 before.
    expect(Math.round((NOW - statsWindowStart(NOW, "UTC", 90, 90)) / day)).toBe(180);
    // Without a range: the 30 best-seller days.
    expect(Math.round((NOW - statsWindowStart(NOW, "UTC")) / day)).toBe(30);
  });

  it("isTimeZone accepts IANA names only", () => {
    expect(isTimeZone("Australia/Sydney")).toBe(true);
    expect(isTimeZone("Mars/Base")).toBe(false);
    expect(isTimeZone(5)).toBe(false);
  });
});

describe("listStatsOrders", () => {
  beforeEach(() => ddb.reset());
  it("reads page after page, skips unpaid statuses in the query, and stops at the cap", async () => {
    let n = 0;
    ddb.on(QueryCommand).callsFake(() => {
      n++;
      const Items = Array.from({ length: 100 }, (_, i) => ({ pk: "p", sk: `ORDER#${1000 - n * 100 - i}#01JBZ0000000000000000000OO`, storeOrderStatus: "PAID" }));
      return { Items, LastEvaluatedKey: { pk: "p", sk: Items[99].sk } };
    });
    const r = await listStatsOrders(STORE, 0, 700);
    expect(r.orders).toHaveLength(700);
    expect(r.partial).toBe(true);
    const values = ddb.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues!;
    expect(Object.values(values)).not.toContain("PENDING_PAYMENT");
    expect(Object.values(values)).not.toContain("CANCELLED");
  });
});

describe("GET /store/overview/:storeId", () => {
  const app = createApp();
  const get = (q = "") => request(app).get(`/api/v1/store/overview/${STORE}${q}`).set("Host", "localhost").set("Authorization", "Bearer t");
  beforeEach(() => {
    ddb.reset();
    resetOverviewCacheForTests();
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "sub-1", "cognito:groups": [] } as any);
  });

  it("answers in the asked zone (unknown zone → UTC), no-store, and caches per range until an order is paid", async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ pk: "p", sk: "s", ...o(Date.now() - 60_000) }] });
    const r = await get("?tz=Mars/Base");
    expect(r.status).toBe(200);
    expect(r.body.tz).toBe("UTC");
    expect(r.body.today.orders).toBe(1);
    expect(r.body.rangeDays).toBe(7);
    expect(r.body.bestSellerDays).toBe(30);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    const reads = ddb.commandCalls(QueryCommand).length;
    await get("?tz=Mars/Base");
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(reads);
    // Another range is another answer.
    const m = await get("?tz=Mars/Base&days=30");
    expect(m.body.rangeDays).toBe(30);
    expect(m.body.days).toHaveLength(30);
    expect(m.body.bestSellerDays).toBe(30);
    expect(ddb.commandCalls(QueryCommand).length).toBeGreaterThan(reads);
    // A paid order forgets the store's answers.
    const before = ddb.commandCalls(QueryCommand).length;
    forgetStoreOverview(STORE);
    await get("?tz=Mars/Base");
    expect(ddb.commandCalls(QueryCommand).length).toBeGreaterThan(before);
    const t = await get(`?tz=${encodeURIComponent(TZ)}`);
    expect(t.body.tz).toBe(TZ);
  });

  it("400 on a repeated tz or a range other than 7, 30 or 90; 500 when the read fails", async () => {
    expect((await get("?tz=UTC&tz=UTC")).status).toBe(400);
    expect((await get("?days=14")).status).toBe(400);
    expect((await get("?days=30&days=7")).status).toBe(400);
    ddb.on(QueryCommand).rejects(new Error("boom"));
    expect((await get()).status).toBe(500);
  });
});
