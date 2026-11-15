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
import { computeStoreOverview, isTimeZone, StatsOrder } from "../layers/core/store-stats";
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

  it("answers in the asked zone (unknown zone → UTC), no-store, and caches for 30 s", async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ pk: "p", sk: "s", ...o(Date.now() - 60_000) }] });
    const r = await get("?tz=Mars/Base");
    expect(r.status).toBe(200);
    expect(r.body.tz).toBe("UTC");
    expect(r.body.today.orders).toBe(1);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    await get("?tz=Mars/Base");
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(1);
    const t = await get(`?tz=${encodeURIComponent(TZ)}`);
    expect(t.body.tz).toBe(TZ);
  });

  it("400 on a repeated tz; 500 when the read fails", async () => {
    expect((await get("?tz=UTC&tz=UTC")).status).toBe(400);
    ddb.on(QueryCommand).rejects(new Error("boom"));
    expect((await get()).status).toBe(500);
  });
});
