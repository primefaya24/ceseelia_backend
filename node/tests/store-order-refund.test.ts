import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

vi.mock("../layers/notifications/order-emails", () => ({
  notifyOrderPaid: vi.fn(async () => {}),
  notifyOrderStatus: vi.fn(async () => {}),
  notifyOrderRefunded: vi.fn(async () => {}),
  notifyReviewDecision: vi.fn(async () => {}),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/customer", () => ({ recordCustomerOrder: vi.fn(async () => "UPDATED") }));
vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  findUserIdByCognitoId: vi.fn(),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getMembership: vi.fn(),
}));
const stripe = { refunds: { create: vi.fn(), list: vi.fn() } };
/* What stripe.refunds.list auto-pages over. */
const live = (...refunds: Array<{ id: string; amount: number; status?: string }>) => ({
  async *[Symbol.asyncIterator]() {
    for (const r of refunds) yield { status: "succeeded", created: 1_700_000_100, failure_reason: null, ...r };
  },
});
vi.mock("../layers/payments/stripe", async (orig) => ({
  ...(await orig<typeof import("../layers/payments/stripe")>()),
  getStripe: vi.fn(async () => stripe),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { findUserIdByCognitoId } from "../layers/aws/dynamodb/dynamo-entities/user";
import { getMembership } from "../layers/aws/dynamodb/dynamo-entities/membership";
import { getStripe, PaymentsNotConfiguredError } from "../layers/payments/stripe";
import { refundRefusal } from "../layers/payments/order-refund";
import { createApp } from "../app";
import { refundableMinor, StoreOrder } from "../layers/core/interfaces/store";
import { recordCustomerOrder } from "../layers/aws/dynamodb/dynamo-entities/customer";
import { notifyOrderPaid, notifyOrderRefunded, notifyOrderStatus, notifyReviewDecision } from "../layers/notifications/order-emails";

const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = "01JBZ0000000000000000000AA";
const OTHER = "01JBZ0000000000000000000BB";
const ORDER_ID = "01JBZ0000000000000000000RD";

const order = (patch: Partial<StoreOrder> = {}): StoreOrder =>
  ({
    storeOrderId: ORDER_ID,
    storeId: STORE,
    storeOrderCode: "K7Q2XM",
    storeOrderStatus: "PAID",
    storeOrderType: "PICKUP",
    storeOrderCurrency: "CAD",
    storeOrderCustomer: { name: "Ann Lee", email: "ann@example.com", phone: "" },
    storeOrderLines: [],
    storeOrderTotalMinor: 2260,
    storeOrderStripe: { accountId: "acct_store", checkoutSessionId: "cs_1", paymentIntentId: "pi_1" },
    storeOrderStatusTokenHash: "secret-hash",
    storeOrderCreatedAt: 1_700_000_000_000,
    storeOrderUpdatedAt: 1_700_000_000_000,
    storeOrderPaidAt: 1_700_000_000_500,
    ...patch,
  }) as StoreOrder;
const sk = (o: StoreOrder) => `ORDER#${o.storeOrderCreatedAt}#${o.storeOrderId}`;

/* Reads return `reads[i]` in turn (the last one repeats): the order before and after the refund. */
function withOrders(...reads: Array<StoreOrder | null>) {
  let n = 0;
  ddb.on(GetCommand).callsFake((input) => {
    const o = reads[Math.min(n, reads.length - 1)];
    if (!o) return {};
    if (input.Key.pk === `ORDER#${ORDER_ID}`) return { Item: { ...input.Key, storeId: o.storeId, orderSk: sk(o) } };
    n++;
    return { Item: { pk: `STORE#${o.storeId}`, sk: sk(o), ...o } };
  });
}

const refund = (b: object = {}) =>
  request(app)
    .post("/api/v1/store/orders/refund")
    .set("Host", "localhost")
    .set("Authorization", "Bearer t")
    .send({ storeId: STORE, orderId: ORDER_ID, amountMinor: 1000, refundedMinor: 0, ...b });

beforeEach(() => {
  for (const fn of [notifyOrderPaid, notifyOrderStatus, notifyOrderRefunded, notifyReviewDecision]) vi.mocked(fn).mockClear();
  ddb.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "s", "cognito:groups": [] });
  vi.mocked(findUserIdByCognitoId).mockReset().mockResolvedValue("U1");
  vi.mocked(getMembership).mockResolvedValue({ storeId: STORE, userId: "U1", role: "ADMIN", createdAt: 1 });
  stripe.refunds.create.mockReset().mockResolvedValue({ id: "re_1", status: "succeeded", charge: "ch_1" });
  stripe.refunds.list.mockReset().mockReturnValue(live({ id: "re_1", amount: 1000 }));
  vi.mocked(getStripe).mockClear();
});

describe("POST /store/orders/refund (6.4)", () => {
  it("a partial refund on the connected account, idempotent on what the merchant saw", async () => {
    const entry = { refundId: "re_1", amountMinor: 1000, status: "succeeded", reason: "requested_by_customer", at: 5, by: "U1" };
    // Read before the refund, then (for the sync) after the entry was appended.
    withOrders(order(), order({ storeOrderRefunds: [entry], storeOrderUpdatedAt: 1_700_000_000_001 }));
    ddb.on(UpdateCommand).resolves({});
    const res = await refund({ reason: "requested_by_customer" });
    expect(res.status).toBe(200);
    expect(res.body.refund).toMatchObject({ refundId: "re_1", amountMinor: 1000, status: "succeeded", reason: "requested_by_customer", by: "U1" });
    expect(res.body.order.storeOrderRefundedMinor).toBe(1000);
    expect(res.body.order.storeOrderStatusTokenHash).toBeUndefined();

    const [params, opts] = stripe.refunds.create.mock.calls[0];
    expect(params).toMatchObject({ payment_intent: "pi_1", amount: 1000, refund_application_fee: false, reason: "requested_by_customer" });
    expect(params.metadata).toEqual({ orderId: ORDER_ID, storeId: STORE, by: "U1" });
    expect(opts).toEqual({ stripeAccount: "acct_store", idempotencyKey: `ceseelia-refund-${ORDER_ID}-0-1000` });
    expect(stripe.refunds.list).toHaveBeenCalledWith({ payment_intent: "pi_1", limit: 100 }, { stripeAccount: "acct_store" });

    const updates = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates).toHaveLength(2);
    // The entry first, then the state synced from Stripe, conditional on the order read.
    expect(updates[0].ExpressionAttributeNames!["#r"]).toBe("storeOrderRefunds");
    expect(updates[1].ConditionExpression).toContain("#upd = :seen");
    expect(updates[1].ExpressionAttributeValues).toMatchObject({ ":ref": 1000, ":st": "PAID", ":seen": 1_700_000_000_001 });
    // 6.5: the shopper hears about the 10.00 that was refunded.
    expect(notifyOrderRefunded).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ storeOrderRefundedMinor: 1000 }), 1000);
    expect(recordCustomerOrder).toHaveBeenCalledWith(expect.objectContaining({ storeOrderRefundedMinor: 1000 }));
  });

  it("refunding what's left makes the order REFUNDED", async () => {
    stripe.refunds.list.mockReturnValue(live({ id: "re_0", amount: 1000 }, { id: "re_1", amount: 1260 }));
    withOrders(order({ storeOrderRefundedMinor: 1000 }));
    ddb.on(UpdateCommand).resolves({});
    const res = await refund({ amountMinor: 1260, refundedMinor: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.order.storeOrderStatus).toBe("REFUNDED");
    expect(res.body.order.storeOrderRefundedMinor).toBe(2260);
    const sync = ddb.commandCalls(UpdateCommand)[1].args[0].input;
    expect(sync.ExpressionAttributeValues).toMatchObject({ ":ref": 2260, ":st": "REFUNDED" });
    // The admin list's Cancelled count: one more fully refunded order.
    const counter = ddb.commandCalls(UpdateCommand)[2].args[0].input;
    expect(counter).toMatchObject({
      Key: { pk: "APP_STORE", sk: `STORE#${STORE}#OVERVIEW` },
      ExpressionAttributeNames: { "#c": "storeCancelledOrdersCount" },
      ExpressionAttributeValues: { ":d": 1 },
    });
  });

  it("409s before calling Stripe: unpaid / refunded, changed meanwhile, too much, disputed", async () => {
    for (const status of ["PENDING_PAYMENT", "CANCELLED", "REFUNDED"] as const) {
      withOrders(order({ storeOrderStatus: status }));
      const res = await refund();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("NOT_REFUNDABLE");
    }
    withOrders(order({ storeOrderRefundedMinor: 500 }));
    let res = await refund();
    expect([res.status, res.body.code, res.body.order.storeOrderRefundedMinor]).toEqual([409, "REFUND_CHANGED", 500]);

    withOrders(order());
    res = await refund({ amountMinor: 2261 });
    expect([res.status, res.body.code]).toEqual([409, "AMOUNT_TOO_LARGE"]);

    withOrders(order({ storeOrderDispute: { status: "needs_response", amountMinor: 2260, updatedAt: 1 } }));
    res = await refund();
    expect([res.status, res.body.code]).toEqual([409, "ORDER_DISPUTED"]);

    // A won dispute doesn't block.
    withOrders(order({ storeOrderDispute: { status: "won", amountMinor: 2260, updatedAt: 1 } }));
    ddb.on(UpdateCommand).resolves({});
    expect((await refund()).status).toBe(200);
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  it("another store's order or an unknown one is 404", async () => {
    withOrders(order({ storeId: OTHER }));
    expect((await refund()).body.code).toBe("ORDER_NOT_FOUND");
    withOrders(null);
    expect((await refund()).status).toBe(404);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("MERCHANT members can't refund; platform admins can", async () => {
    vi.mocked(getMembership).mockResolvedValue({ storeId: STORE, userId: "U1", role: "MERCHANT", createdAt: 1 });
    expect((await refund()).status).toBe(403);
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "s", "cognito:groups": ["Admins"] });
    withOrders(order());
    ddb.on(UpdateCommand).resolves({});
    const res = await refund();
    expect(res.status).toBe(200);
    expect(res.body.refund.by).toBe("ADMIN");
  });

  it("400 on bad amounts, totals or reasons", async () => {
    for (const b of [{ amountMinor: 0 }, { amountMinor: 1.5 }, { amountMinor: "10" }, { refundedMinor: -1 }, { reason: "because" }]) {
      expect((await refund(b)).status).toBe(400);
    }
  });

  it("Stripe's refusals are 409s with the current order; other errors 502, no key 503", async () => {
    withOrders(order());
    stripe.refunds.create.mockRejectedValueOnce({ type: "StripeInvalidRequestError", code: "balance_insufficient" });
    let res = await refund();
    expect([res.status, res.body.code]).toEqual([409, "INSUFFICIENT_BALANCE"]);

    stripe.refunds.create.mockRejectedValueOnce({ type: "StripeInvalidRequestError", message: "Refund amount ($10.00) is greater than unrefunded amount on charge ($5.00)" });
    res = await refund();
    expect([res.status, res.body.code]).toEqual([409, "AMOUNT_TOO_LARGE"]);

    stripe.refunds.create.mockRejectedValueOnce({ type: "StripeAPIError", message: "boom" });
    res = await refund();
    expect([res.status, res.body.code]).toEqual([502, "STRIPE_ERROR"]);

    vi.mocked(getStripe).mockRejectedValueOnce(new PaymentsNotConfiguredError("no key"));
    res = await refund();
    expect([res.status, res.body.code]).toEqual([503, "PAYMENTS_NOT_CONFIGURED"]);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("the refund still answers 200 when recording it fails (the webhook syncs it)", async () => {
    withOrders(order());
    ddb.on(UpdateCommand).rejects(new Error("ddb down"));
    const res = await refund();
    expect(res.status).toBe(200);
    expect(res.body.refund.refundId).toBe("re_1");
    expect(res.body.order.storeOrderRefundedMinor).toBe(1000);
  });
});

describe("refund helpers", () => {
  it("refundableMinor and refundRefusal", () => {
    expect(refundableMinor({ storeOrderTotalMinor: 2260, storeOrderRefundedMinor: 1000 })).toBe(1260);
    expect(refundableMinor({ storeOrderTotalMinor: 2260 })).toBe(2260);
    expect(refundRefusal({ type: "StripeInvalidRequestError", code: "charge_already_refunded" })).toBe("ALREADY_REFUNDED");
    expect(refundRefusal({ type: "StripeInvalidRequestError", code: "charge_disputed" })).toBe("DISPUTED");
    expect(refundRefusal({ type: "StripeCardError", code: "charge_disputed" })).toBeNull();
    expect(refundRefusal(new Error("x"))).toBeNull();
  });
});
