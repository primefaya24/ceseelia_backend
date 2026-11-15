import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

vi.mock("../layers/notifications/order-emails", () => ({
  notifyOrderPaid: vi.fn(async () => {}),
  notifyOrderStatus: vi.fn(async () => {}),
  notifyOrderRefunded: vi.fn(async () => {}),
  notifyReviewDecision: vi.fn(async () => {}),
}));
vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  findUserIdByCognitoId: vi.fn(),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getMembership: vi.fn(),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { findUserIdByCognitoId } from "../layers/aws/dynamodb/dynamo-entities/user";
import { getMembership } from "../layers/aws/dynamodb/dynamo-entities/membership";
import { createApp } from "../app";
import { nextOrderStatuses, StoreOrder } from "../layers/core/interfaces/store";
import { notifyOrderPaid, notifyOrderRefunded, notifyOrderStatus, notifyReviewDecision } from "../layers/notifications/order-emails";

const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = "01JBZ0000000000000000000AA";
const OTHER = "01JBZ0000000000000000000BB";
const ORDER_ID = "01JBZ0000000000000000000RD";

const order = (patch: Partial<StoreOrder> = {}, i = 0): StoreOrder =>
  ({
    storeOrderId: i ? `01JBZ00000000000000000000${"ABCDEFGHJK"[i % 10]}` : ORDER_ID,
    storeId: STORE,
    storeOrderCode: "K7Q2XM",
    storeOrderStatus: "PAID",
    storeOrderType: "PICKUP",
    storeOrderCurrency: "CAD",
    storeOrderCustomer: { name: "Ann Lee", email: "ann@example.com", phone: "" },
    storeOrderLines: [{ itemId: "x", itemName: "Tea", quantity: 2, params: [], unitPriceMinor: 1, discountPercent: 0, subtotalMinor: 2, discountMinor: 0, totalMinor: 2 }],
    storeOrderTotalMinor: 2260,
    storeOrderStatusTokenHash: "secret-hash",
    storeOrderCreatedAt: 1_700_000_000_000 - i,
    storeOrderUpdatedAt: 1_700_000_000_000,
    storeOrderPaidAt: 1_700_000_000_500,
    ...patch,
  }) as StoreOrder;
const row = (o: StoreOrder) => ({ pk: `STORE#${o.storeId}`, sk: `ORDER#${o.storeOrderCreatedAt}#${o.storeOrderId}`, ...o });

const auth = (r: request.Test) => r.set("Host", "localhost").set("Authorization", "Bearer t");
const list = (qs = "") => auth(request(app).get(`/api/v1/store/orders/list/${STORE}${qs}`));
const get = (id = ORDER_ID) => auth(request(app).get(`/api/v1/store/orders/get/${STORE}/${id}`));
const move = (b: object) =>
  auth(request(app).put("/api/v1/store/orders/update-status")).send({ storeId: STORE, orderId: ORDER_ID, ...b });

function withOrder(o: StoreOrder | null) {
  ddb.on(GetCommand).callsFake((input) => {
    if (!o) return {};
    if (input.Key.pk === `ORDER#${ORDER_ID}`) return { Item: { ...input.Key, storeId: o.storeId, orderSk: row(o).sk } };
    if (input.Key.sk === row(o).sk) return { Item: row(o) };
    return {};
  });
}

beforeEach(() => {
  for (const fn of [notifyOrderPaid, notifyOrderStatus, notifyOrderRefunded, notifyReviewDecision]) vi.mocked(fn).mockClear();
  ddb.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "s", "cognito:groups": [] });
  vi.mocked(findUserIdByCognitoId).mockReset().mockResolvedValue("U1");
  vi.mocked(getMembership).mockResolvedValue({ storeId: STORE, userId: "U1", role: "MERCHANT", createdAt: 1 });
});

describe("nextOrderStatuses (6.3)", () => {
  it("forward only; Shipped only for deliveries; nothing from unpaid, cancelled or refunded", () => {
    expect(nextOrderStatuses("PAID", "PICKUP")).toEqual(["PREPARING", "READY", "COMPLETED"]);
    expect(nextOrderStatuses("READY", "DELIVERY")).toEqual(["SHIPPED", "COMPLETED"]);
    expect(nextOrderStatuses("COMPLETED", "DELIVERY")).toEqual([]);
    for (const s of ["PENDING_PAYMENT", "CANCELLED", "REFUNDED"] as const) expect(nextOrderStatuses(s, "DELIVERY")).toEqual([]);
  });
});

describe("GET /store/orders/list (6.1)", () => {
  it("newest first, paid-type statuses by default, rows as summaries", async () => {
    ddb.on(QueryCommand).resolves({ Items: [row(order())] });
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const q = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(q).toMatchObject({ ScanIndexForward: false, KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high" });
    expect(Object.values(q.ExpressionAttributeValues!)).not.toContain("PENDING_PAYMENT");
    expect(Object.values(q.ExpressionAttributeValues!)).toContain("REFUNDED");
    expect(res.body).toEqual({
      next: null,
      orders: [
        {
          orderId: ORDER_ID,
          orderCode: "K7Q2XM",
          status: "PAID",
          cancelReason: null,
          type: "PICKUP",
          currency: "CAD",
          customerName: "Ann Lee",
          itemCount: 2,
          totalMinor: 2260,
          refundedMinor: 0,
          createdAt: 1_700_000_000_000,
          paidAt: 1_700_000_000_500,
          updatedAt: 1_700_000_000_000,
          stockShortfall: false,
          disputeStatus: null,
        },
      ],
    });
  });

  it("status and date filters; the cursor resumes after the last row returned", async () => {
    const rows = [1, 2, 3].map((i) => row(order({}, i)));
    ddb.on(QueryCommand).resolves({ Items: rows, LastEvaluatedKey: { pk: "x", sk: "y" } });
    const res = await list("?status=preparing,READY&from=1000&to=2000&limit=2");
    const q = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(q.ExpressionAttributeValues).toMatchObject({ ":low": "ORDER#1000", ":high": "ORDER#2000#~", ":s0": "PREPARING", ":s1": "READY" });
    expect(res.body.orders).toHaveLength(2);
    expect(res.body.next).toBe(rows[1].sk);

    ddb.resetHistory();
    await list(`?cursor=${encodeURIComponent(rows[1].sk)}`);
    expect(ddb.commandCalls(QueryCommand)[0].args[0].input.ExclusiveStartKey).toEqual({ pk: `STORE#${STORE}`, sk: rows[1].sk });
  });

  it("filtered pages are read again to fill the limit, a few times at most", async () => {
    ddb.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: { pk: `STORE#${STORE}`, sk: "ORDER#5#01JBZ0000000000000000000RD" } });
    const res = await list("?status=COMPLETED");
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(5);
    expect(res.body).toEqual({ orders: [], next: "ORDER#5#01JBZ0000000000000000000RD" });
  });

  it.each(["?status=NOPE", "?from=5&to=1", "?from=abc", "?limit=0", "?limit=101", "?cursor=STORE%23x"])("400 for %s", async (qs) => {
    expect((await list(qs)).status).toBe(400);
  });
});

describe("GET /store/orders/get (6.2)", () => {
  it("the whole order without the shopper's token hash", async () => {
    withOrder(order());
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ storeOrderId: ORDER_ID, storeOrderTotalMinor: 2260 });
    expect(res.body).not.toHaveProperty("storeOrderStatusTokenHash");
  });

  it("another store's order, or none, is 404", async () => {
    withOrder(order({ storeId: OTHER }));
    expect((await get()).body.code).toBe("ORDER_NOT_FOUND");
    withOrder(null);
    expect((await get()).status).toBe(404);
    expect((await get("nope")).status).toBe(400);
  });
});

describe("PUT /store/orders/update-status (6.3)", () => {
  it("moves a paid order on from the status the merchant saw, with history", async () => {
    withOrder(order());
    ddb.on(UpdateCommand).resolves({});
    const res = await move({ fromStatus: "PAID", status: "READY" });
    expect(res.status).toBe(200);
    expect(res.body.storeOrderStatus).toBe("READY");
    expect(res.body.storeOrderStatusHistory).toEqual([{ status: "READY", at: expect.any(Number), by: "U1" }]);
    expect(res.body).not.toHaveProperty("storeOrderStatusTokenHash");
    const u = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(u.ConditionExpression).toBe("attribute_exists(pk) AND #st = :from");
    expect(u.ExpressionAttributeValues).toMatchObject({ ":from": "PAID", ":to": "READY", ":entry": [{ status: "READY", by: "U1" }] });
    // 6.5: the email module decides whether the shopper hears about it.
    expect(notifyOrderStatus).toHaveBeenCalledWith(expect.objectContaining({ storeOrderId: ORDER_ID, storeOrderStatus: "READY" }), "READY");
  });

  it("409 INVALID_TRANSITION: backwards, Shipped for a pickup, or an unpaid / cancelled order", async () => {
    for (const [o, b] of [
      [order({ storeOrderStatus: "READY" }), { fromStatus: "READY", status: "PREPARING" }],
      [order(), { fromStatus: "PAID", status: "SHIPPED" }],
      [order({ storeOrderStatus: "PENDING_PAYMENT" }), { fromStatus: "PENDING_PAYMENT", status: "PAID" }],
      [order({ storeOrderStatus: "CANCELLED" }), { fromStatus: "CANCELLED", status: "COMPLETED" }],
      [order(), { fromStatus: "PAID", status: "CANCELLED" }],
    ] as const) {
      withOrder(o);
      const res = await move(b);
      expect([res.status, res.body.code]).toEqual([409, "INVALID_TRANSITION"]);
    }
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(notifyOrderStatus).not.toHaveBeenCalled();
  });

  it("409 STATUS_CHANGED with the current order when someone moved it meanwhile", async () => {
    withOrder(order({ storeOrderStatus: "PREPARING" }));
    const stale = await move({ fromStatus: "PAID", status: "READY" });
    expect([stale.status, stale.body.code, stale.body.order.storeOrderStatus]).toEqual([409, "STATUS_CHANGED", "PREPARING"]);

    // The race: read as PAID, changed before the write
    withOrder(order());
    ddb.on(UpdateCommand).rejects(Object.assign(new Error("c"), { name: "ConditionalCheckFailedException" }));
    const raced = await move({ fromStatus: "PAID", status: "READY" });
    expect(raced.body.code).toBe("STATUS_CHANGED");
  });

  it("another store's order is 404; bad bodies 400", async () => {
    withOrder(order({ storeId: OTHER }));
    expect((await move({ fromStatus: "PAID", status: "READY" })).status).toBe(404);
    expect((await move({ fromStatus: "PAID", status: "DONE" })).status).toBe(400);
    expect((await move({ status: "READY" })).status).toBe(400);
  });
});
