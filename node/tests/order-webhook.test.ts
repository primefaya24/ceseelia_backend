import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import Stripe from "stripe";
import { mockClient } from "aws-sdk-client-mock";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const realStripe = new Stripe("sk_test_123");
const stripe = { paymentIntents: { retrieve: vi.fn() }, webhooks: realStripe.webhooks };
const secrets = { secretKey: "sk_test_123", webhookSecret: "whsec_connect", billingWebhookSecret: "whsec_billing" };
vi.mock("../layers/payments/stripe", async (orig) => ({
  ...(await orig<typeof import("../layers/payments/stripe")>()),
  getStripe: vi.fn(async () => stripe),
  getStripeSecrets: vi.fn(async () => secrets),
}));

import { createApp } from "../app";
import { stockUpdates } from "../layers/aws/dynamodb/dynamo-entities/order";
import { StoreItem, StoreOrder } from "../layers/core/interfaces/store";

const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = "01JBZ0000000000000000000AA";
const ORDER_ID = "01JBZ0000000000000000000OO";
const CREATED = 1_700_000_000_000;
const ORDER_SK = `ORDER#${CREATED}#${ORDER_ID}`;
const TEA = "01JBZ00000000000000000TEA0";
const SHIRT = "01JBZ0000000000000000SHIRT";

const order = (patch: Partial<StoreOrder> = {}): StoreOrder =>
  ({
    storeOrderId: ORDER_ID,
    storeId: STORE,
    storeOrderCode: "K7Q2XM",
    storeOrderStatus: "PENDING_PAYMENT",
    storeOrderType: "PICKUP",
    storeOrderCurrency: "USD",
    storeOrderLines: [
      { itemId: TEA, itemName: "Tea", quantity: 2, params: [], unitPriceMinor: 1000, discountPercent: 0, subtotalMinor: 2000, discountMinor: 0, totalMinor: 2000 },
      { itemId: SHIRT, itemName: "Shirt", quantity: 1, params: [{ label: "Size", values: ["M"] }], unitPriceMinor: 2500, discountPercent: 0, subtotalMinor: 2500, discountMinor: 0, totalMinor: 2500 },
      { itemId: SHIRT, itemName: "Shirt", quantity: 3, params: [{ label: "Size", values: ["L"] }], unitPriceMinor: 2500, discountPercent: 0, subtotalMinor: 7500, discountMinor: 0, totalMinor: 7500 },
    ],
    storeOrderTotalMinor: 12000,
    storeOrderPlatformFeeMinor: 145,
    storeOrderStripe: { accountId: "acct_store", checkoutSessionId: "cs_1", paymentIntentId: "" },
    storeOrderCreatedAt: CREATED,
    storeOrderUpdatedAt: CREATED,
    ...patch,
  }) as StoreOrder;

const shirt = (stocks: [number, number] = [5, 5], itemStock = 10): StoreItem =>
  ({
    storeItemId: SHIRT,
    storeItemStock: itemStock,
    storeItemCustomParams: [{ storeParamLabel: "Size", storeParamType: "SINGLE_SELECT", storeParamIsMandatory: true, storeParamOptions: ["M", "L"] }],
    storeItemVariants: [
      { storeVariantOptions: { Size: "M" }, storeVariantStock: stocks[0], storeVariantPrices: { USD: 2500 }, storeVariantIsActive: true },
      { storeVariantOptions: { Size: "L" }, storeVariantStock: stocks[1], storeVariantPrices: { USD: 2500 }, storeVariantIsActive: true },
    ],
  }) as unknown as StoreItem;
const tea = (stock = 9): StoreItem => ({ storeItemId: TEA, storeItemStock: stock, storeItemCustomParams: [] }) as unknown as StoreItem;

/* The order behind its pointer, the items, and which events were already processed. */
function world({ o = order(), items = [tea(), shirt()], processed = [] as string[] } = {}) {
  ddb.on(GetCommand).callsFake((input) => {
    const { pk, sk } = input.Key;
    if (pk === `ORDER#${ORDER_ID}`) return { Item: { pk, sk, storeId: STORE, orderSk: ORDER_SK } };
    if (pk === `STORE#${STORE}` && sk === ORDER_SK) return { Item: { pk, sk, ...o } };
    if (pk.startsWith("STRIPE_EVENT#")) return processed.includes(pk.slice(13)) ? { Item: { pk, sk } } : {};
    return {};
  });
  ddb.on(BatchGetCommand).callsFake((input) => {
    const table = Object.keys(input.RequestItems)[0];
    return { Responses: { [table]: items.map((i) => ({ pk: `STORE#${STORE}`, sk: `ITEM#${i.storeItemId}`, ...i })) } };
  });
  ddb.on(TransactWriteCommand).resolves({});
  ddb.on(UpdateCommand).resolves({});
  ddb.on(PutCommand).resolves({});
}

let seq = 0;
function send(type: string, object: object, account: string | null = "acct_store", secret = "whsec_connect") {
  const payload = JSON.stringify({ id: `evt_${++seq}`, object: "event", type, account, data: { object } });
  return request(app)
    .post("/api/v1/payments/stripe-connect-webhook")
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", realStripe.webhooks.generateTestHeaderString({ payload, secret }))
    .send(payload);
}
const session = (patch: object = {}) => ({
  id: "cs_1",
  object: "checkout.session",
  mode: "payment",
  payment_status: "paid",
  payment_intent: "pi_1",
  metadata: { orderId: ORDER_ID, storeId: STORE },
  client_reference_id: ORDER_ID,
  ...patch,
});
const cancelled = (codes: string[]) =>
  Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) });
const tx = (i = 0) => ddb.commandCalls(TransactWriteCommand)[i].args[0].input.TransactItems!;

beforeEach(() => {
  ddb.reset();
  stripe.paymentIntents.retrieve.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("Connect webhook: signature and routing (5.5a/b)", () => {
  it("400 without a valid signature; nothing read", async () => {
    world();
    const bad = await send("checkout.session.completed", session(), "acct_store", "whsec_wrong");
    expect([bad.status, bad.body.code]).toEqual([400, "BAD_SIGNATURE"]);
    expect(ddb.calls()).toHaveLength(0);
  });

  it("ignores platform events (no `account`)", async () => {
    world();
    expect((await send("checkout.session.completed", session(), null)).status).toBe(200);
    expect(ddb.calls()).toHaveLength(0);
  });

  it("skips an event already processed; records new ones", async () => {
    world({ processed: [`evt_${seq + 1}`] });
    const res = await send("checkout.session.completed", session());
    expect(res.body.duplicate).toBe(true);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);

    world();
    await send("checkout.session.expired", session({ payment_status: "unpaid" }));
    const put = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(put).toMatchObject({ pk: `STRIPE_EVENT#evt_${seq}`, sk: "EVENT", type: "checkout.session.expired" });
  });

  it("a failure is a 500 (Stripe retries) and the event isn't marked processed", async () => {
    world();
    ddb.on(TransactWriteCommand).rejects(new Error("throttled"));
    const res = await send("checkout.session.completed", session());
    expect(res.status).toBe(500);
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe("paid (5.5c / 5.6)", () => {
  it("PENDING_PAYMENT → PAID with stock, the store's count and the sales record in one transaction", async () => {
    world();
    expect((await send("checkout.session.completed", session())).status).toBe(200);
    const items = tx();
    expect(items).toHaveLength(5); // order, tea, shirt, count, sale
    expect(items[0].Update).toMatchObject({
      Key: { pk: `STORE#${STORE}`, sk: ORDER_SK },
      ConditionExpression: "#st = :pending",
      ExpressionAttributeValues: { ":paid": "PAID", ":pi": "pi_1" },
    });
    expect(items[0].Update!.UpdateExpression).not.toContain("#short");
    expect(items[1].Update).toMatchObject({ Key: { sk: `ITEM#${TEA}` }, ExpressionAttributeValues: { ":q": 2 } });
    expect(items[2].Update!.ExpressionAttributeValues).toMatchObject({ ":q0": 1, ":q1": 3, ":q": 4 });
    expect(items[3].Update).toMatchObject({ Key: { pk: "APP_STORE", sk: `STORE#${STORE}#OVERVIEW` }, UpdateExpression: "ADD #count :one" });
    expect(items[4].Put!.Item).toMatchObject({ pk: "APP", storeId: STORE, orderId: ORDER_ID, totalMinor: 12000, platformFeeMinor: 145 });
    expect(items[4].Put!.Item!.sk).toMatch(new RegExp(`^ORDER#\\d+#STORE#${STORE}#${ORDER_ID}$`));
  });

  it("a delayed payment method: nothing until async_payment_succeeded", async () => {
    world();
    await send("checkout.session.completed", session({ payment_status: "unpaid" }));
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    await send("checkout.session.async_payment_succeeded", session());
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it("already paid (repeat): the condition fails, nothing else is tried", async () => {
    world();
    ddb.on(TransactWriteCommand).rejects(cancelled(["ConditionalCheckFailed", "None", "None", "None", "None"]));
    expect((await send("checkout.session.completed", session())).status).toBe(200);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it("stock ran out after paying: still PAID, flagged short, no stock change", async () => {
    world();
    ddb
      .on(TransactWriteCommand)
      .rejectsOnce(cancelled(["None", "None", "ConditionalCheckFailed", "None", "None"]))
      .resolves({});
    expect((await send("checkout.session.completed", session())).status).toBe(200);
    const retry = tx(1);
    expect(retry.map((t) => Object.keys(t)[0])).toEqual(["Update", "Update", "Put"]);
    expect(retry[0].Update!.ExpressionAttributeValues).toMatchObject({ ":true": true });
    expect(retry[1].Update!.Key).toMatchObject({ pk: "APP_STORE" });
  });

  it("an item deleted since: paid and flagged short, the rest decremented", async () => {
    world({ items: [shirt()] });
    await send("checkout.session.completed", session());
    const items = tx();
    expect(items[0].Update!.ExpressionAttributeValues).toMatchObject({ ":true": true });
    expect(items.filter((t) => t.Update?.Key?.sk?.toString().startsWith("ITEM#"))).toHaveLength(1);
  });

  it("only the order's own account and session can pay it", async () => {
    world();
    await send("checkout.session.completed", session(), "acct_someone_else");
    await send("checkout.session.completed", session({ id: "cs_other" }));
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("unknown order ids and subscription sessions are ignored", async () => {
    world();
    await send("checkout.session.completed", session({ metadata: { orderId: "01JBZ0000000000000000NOPE0" }, client_reference_id: null }));
    await send("checkout.session.completed", session({ mode: "subscription" }));
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe("expired, failed, refunds, disputes, account (5.5c/d)", () => {
  it.each([
    ["checkout.session.expired", "PAYMENT_EXPIRED"],
    ["checkout.session.async_payment_failed", "PAYMENT_FAILED"],
  ])("%s cancels a pending order (%s)", async (type, reason) => {
    world();
    await send(type, session({ payment_status: "unpaid" }));
    expect(ddb.commandCalls(UpdateCommand)[0].args[0].input).toMatchObject({
      Key: { sk: ORDER_SK },
      ConditionExpression: "#st = :pending",
      ExpressionAttributeValues: { ":cancelled": "CANCELLED", ":why": reason },
    });
  });

  it("payment_intent.payment_failed changes nothing (the shopper can retry until expiry)", async () => {
    world();
    await send("payment_intent.payment_failed", { id: "pi_1", object: "payment_intent" });
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("charge.refunded: amount refunded, REFUNDED when full; only the order's own payment", async () => {
    world({ o: order({ storeOrderStatus: "PAID", storeOrderStripe: { accountId: "acct_store", checkoutSessionId: "cs_1", paymentIntentId: "pi_1" } }) });
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", metadata: { orderId: ORDER_ID } });
    await send("charge.refunded", { id: "ch_1", object: "charge", payment_intent: "pi_1", amount: 12000, amount_refunded: 12000, refunded: true });
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith("pi_1", {}, { stripeAccount: "acct_store" });
    expect(ddb.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues).toMatchObject({ ":ref": 12000, ":refunded": "REFUNDED" });

    ddb.resetHistory();
    await send("charge.refunded", { id: "ch_1", object: "charge", payment_intent: "pi_1", amount: 12000, amount_refunded: 500, refunded: false });
    const partial = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(partial.ExpressionAttributeValues).toMatchObject({ ":ref": 500 });
    expect(partial.UpdateExpression).not.toContain(":refunded");

    ddb.resetHistory();
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_2", metadata: { orderId: ORDER_ID } });
    await send("charge.refunded", { id: "ch_2", object: "charge", payment_intent: "pi_2", amount: 1, amount_refunded: 1, refunded: true });
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("charge.dispute.*: the dispute's status on the order", async () => {
    world({ o: order({ storeOrderStatus: "PAID", storeOrderStripe: { accountId: "acct_store", checkoutSessionId: "cs_1", paymentIntentId: "pi_1" } }) });
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", metadata: { orderId: ORDER_ID } });
    await send("charge.dispute.created", { id: "dp_1", object: "dispute", payment_intent: "pi_1", status: "needs_response", amount: 12000 });
    expect(ddb.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues![":d"]).toMatchObject({
      status: "needs_response",
      amountMinor: 12000,
    });
  });

  it("account.updated refreshes the store's payments flags, only for its own account", async () => {
    world();
    const account = { id: "acct_store", object: "account", metadata: { storeId: STORE }, charges_enabled: false, payouts_enabled: true, details_submitted: true };
    await send("account.updated", account);
    expect(ddb.commandCalls(UpdateCommand)[0].args[0].input).toMatchObject({
      Key: { pk: `STORE#${STORE}`, sk: "SETTINGS" },
      ConditionExpression: "#payments.#acct = :acct",
      ExpressionAttributeValues: { ":acct": "acct_store", ":charges": false, ":payouts": true },
    });
    ddb.resetHistory();
    await send("account.updated", account, "acct_other");
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe("stockUpdates (5.6b)", () => {
  it("one update per item; variant rows by their options; unlimited stock untouched", () => {
    const { updates, missing } = stockUpdates(STORE, order().storeOrderLines, [tea(-1), shirt([-1, 5], -1)]);
    expect(missing).toBe(false);
    expect(updates).toHaveLength(1); // only shirt L is tracked
    expect(updates[0].Update).toMatchObject({
      UpdateExpression: "SET #v[1].#vs = #v[1].#vs - :q1",
      ConditionExpression: "#v[1].#vs >= :q1 AND #v[1].#vo = :o1",
      ExpressionAttributeValues: { ":q1": 3, ":o1": { Size: "L" } },
    });
  });

  it("a row that no longer exists is missing", () => {
    const lines = [{ ...order().storeOrderLines[1], params: [{ label: "Size", values: ["XL"] }] }];
    expect(stockUpdates(STORE, lines, [shirt()]).missing).toBe(true);
  });
});
