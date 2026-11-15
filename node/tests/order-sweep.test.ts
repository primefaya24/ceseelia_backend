import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const stripe = {
  checkout: { sessions: { retrieve: vi.fn(), expire: vi.fn() } },
  paymentIntents: { retrieve: vi.fn() },
};
vi.mock("../layers/payments/stripe", async (orig) => ({
  ...(await orig<typeof import("../layers/payments/stripe")>()),
  getStripe: vi.fn(async () => stripe),
}));

import { sweepLostOrders, SWEEP_MARGIN_MS } from "../layers/payments/order-sweep";
import { ORDER_CHECKOUT_LIFETIME_S } from "../layers/payments/order-checkout";
import { getStripe } from "../layers/payments/stripe";
import { StoreOrder } from "../layers/core/interfaces/store";

const ddb = mockClient(DynamoDBDocumentClient);
const STORE = "01JBZ0000000000000000000AA";
const ORDER_ID = "01JBZ0000000000000000000RD";
const CREATED = 1_700_000_000_000;
const SK = `ORDER#${CREATED}#${ORDER_ID}`;
const NOW = CREATED + 2 * 60 * 60 * 1000;

const order = (patch: Partial<StoreOrder> = {}): StoreOrder =>
  ({
    storeOrderId: ORDER_ID,
    storeId: STORE,
    storeOrderStatus: "PENDING_PAYMENT",
    storeOrderCurrency: "CAD",
    storeOrderLines: [],
    storeOrderTotalMinor: 2000,
    storeOrderPlatformFeeMinor: 195,
    storeOrderStripe: { accountId: "acct_store", checkoutSessionId: "cs_1", paymentIntentId: "" },
    storeOrderCreatedAt: CREATED,
    storeOrderUpdatedAt: CREATED,
    ...patch,
  }) as StoreOrder;

function world(o: StoreOrder | null, rows = [{ pk: "APP_PENDING_ORDER", sk: SK, storeId: STORE, orderId: ORDER_ID, orderSk: SK }]) {
  ddb.on(QueryCommand).resolves({ Items: rows });
  ddb.on(GetCommand).callsFake((input) => {
    if (!o) return {};
    if (input.Key.pk === `ORDER#${ORDER_ID}`) return { Item: { ...input.Key, storeId: STORE, orderSk: SK } };
    if (input.Key.sk === SK) return { Item: { pk: `STORE#${STORE}`, sk: SK, ...o } };
    return {};
  });
  ddb.on(BatchGetCommand).callsFake((input) => ({ Responses: { [Object.keys(input.RequestItems)[0]]: [] } }));
  ddb.on(UpdateCommand).resolves({});
  ddb.on(TransactWriteCommand).resolves({});
  ddb.on(DeleteCommand).resolves({});
}
const cancelCall = () => ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input).find((i) => i.ExpressionAttributeValues?.[":cancelled"]);
const deleted = () => ddb.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key);

beforeEach(() => {
  ddb.reset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  stripe.checkout.sessions.retrieve.mockReset();
  stripe.checkout.sessions.expire.mockReset();
  stripe.paymentIntents.retrieve.mockReset();
  vi.mocked(getStripe).mockClear();
});

describe("sweepLostOrders (5.7)", () => {
  it("only asks for orders whose checkout should have ended; nothing listed → no Stripe", async () => {
    world(null, []);
    expect(await sweepLostOrders(() => NOW)).toMatchObject({ checked: 0 });
    const q = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(q.KeyConditionExpression).toBe("pk = :pk AND sk < :before");
    expect(q.ExpressionAttributeValues).toEqual({
      ":pk": "APP_PENDING_ORDER",
      ":before": `ORDER#${NOW - ORDER_CHECKOUT_LIFETIME_S * 1000 - SWEEP_MARGIN_MS}`,
    });
    expect(getStripe).not.toHaveBeenCalled();
  });

  it("an order already settled (or gone) just leaves the list", async () => {
    world(order({ storeOrderStatus: "PAID" }));
    expect(await sweepLostOrders(() => NOW)).toMatchObject({ checked: 1, cleared: 1 });
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(deleted()).toEqual([{ pk: "APP_PENDING_ORDER", sk: SK }]);
  });

  it("expired session → CANCELLED (PAYMENT_EXPIRED), on the store's account", async () => {
    world(order());
    stripe.checkout.sessions.retrieve.mockResolvedValue({ id: "cs_1", status: "expired" });
    expect(await sweepLostOrders(() => NOW)).toMatchObject({ cancelled: 1 });
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledWith("cs_1", {}, { stripeAccount: "acct_store" });
    expect(cancelCall()).toMatchObject({ ConditionExpression: "#st = :pending", ExpressionAttributeValues: expect.objectContaining({ ":why": "PAYMENT_EXPIRED" }) });
    expect(deleted()).toHaveLength(1);
  });

  it("a session still open past its expiry is expired first", async () => {
    world(order());
    stripe.checkout.sessions.retrieve.mockResolvedValue({ id: "cs_1", status: "open" });
    stripe.checkout.sessions.expire.mockResolvedValue({ id: "cs_1", status: "expired" });
    expect(await sweepLostOrders(() => NOW)).toMatchObject({ cancelled: 1 });
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_1", {}, { stripeAccount: "acct_store" });
  });

  it("if expiring fails (paid meanwhile), the row stays for the next run", async () => {
    world(order());
    stripe.checkout.sessions.retrieve.mockResolvedValue({ id: "cs_1", status: "open" });
    stripe.checkout.sessions.expire.mockRejectedValue(new Error("session is complete"));
    expect(await sweepLostOrders(() => NOW)).toMatchObject({ kept: 1 });
    expect(cancelCall()).toBeUndefined();
    expect(deleted()).toHaveLength(0);
  });

  it("a paid session whose webhook never came → PAID through markOrderPaid", async () => {
    world(order());
    stripe.checkout.sessions.retrieve.mockResolvedValue({ id: "cs_1", status: "complete", payment_status: "paid", payment_intent: "pi_1" });
    expect(await sweepLostOrders(() => NOW)).toMatchObject({ paid: 1 });
    const items = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(items[0].Update!.ExpressionAttributeValues).toMatchObject({ ":paid": "PAID", ":pi": "pi_1" });
    expect(deleted()).toHaveLength(1);
  });

  it.each([
    ["succeeded", "paid"],
    ["canceled", "cancelled"],
    ["requires_payment_method", "cancelled"],
    ["processing", "kept"],
  ])("complete but unpaid: PaymentIntent %s → %s", async (piStatus, outcome) => {
    world(order());
    stripe.checkout.sessions.retrieve.mockResolvedValue({ id: "cs_1", status: "complete", payment_status: "unpaid", payment_intent: "pi_1" });
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", status: piStatus });
    const r = await sweepLostOrders(() => NOW);
    expect(r[outcome as "paid"]).toBe(1);
    if (outcome === "cancelled") expect(cancelCall()!.ExpressionAttributeValues![":why"]).toBe("PAYMENT_FAILED");
    expect(deleted()).toHaveLength(outcome === "kept" ? 0 : 1);
  });

  it("a session missing on the account → cancelled; other Stripe errors keep the row", async () => {
    world(order());
    stripe.checkout.sessions.retrieve.mockRejectedValueOnce({ code: "resource_missing" });
    expect(await sweepLostOrders(() => NOW)).toMatchObject({ cancelled: 1 });

    ddb.resetHistory();
    stripe.checkout.sessions.retrieve.mockRejectedValueOnce(new Error("Stripe is down"));
    expect(await sweepLostOrders(() => NOW)).toMatchObject({ failed: 1 });
    expect(deleted()).toHaveLength(0);
  });
});
