import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

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
import { StoreOrder } from "../layers/core/interfaces/store";
import {
  customerFromRow,
  customerIdFor,
  listStoreCustomers,
  recordCustomerOrder,
} from "../layers/aws/dynamodb/dynamo-entities/customer";

const ddb = mockClient(DynamoDBDocumentClient);
const STORE = "01JBZ0000000000000000000AA";
const ORDER = "01JBZ0000000000000000000OO";
const CID = customerIdFor("ann@example.com");

const order = (over: Partial<StoreOrder> = {}): StoreOrder =>
  ({
    storeOrderId: ORDER,
    storeId: STORE,
    storeOrderCode: "K7Q2XM",
    storeOrderStatus: "PAID",
    storeOrderType: "PICKUP",
    storeOrderCurrency: "CAD",
    storeOrderTotalMinor: 4550,
    storeOrderPaidAt: 1_700_000_000_000,
    storeOrderCustomer: { name: "Ann Lee", email: " Ann@Example.com ", phone: "555" },
    ...over,
  }) as StoreOrder;

beforeEach(() => ddb.reset());

describe("recordCustomerOrder (L.7 / 7.1)", () => {
  it("a first paid order: marker + counters in one conditional transaction, then the newest details", async () => {
    ddb.on(GetCommand).resolves({});
    expect(await recordCustomerOrder(order({ storeOrderRefundedMinor: 550 }))).toBe("ADDED");
    const tx = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(tx[0].Put!.Item).toEqual({ pk: `STORE#${STORE}`, sk: `CUSTOMER_ORDER#${ORDER}`, customerId: CID, currency: "CAD", refundedMinor: 550 });
    expect(tx[0].Put!.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(tx[1].Update!.Key).toEqual({ pk: `STORE#${STORE}`, sk: `CUSTOMER#${CID}` });
    expect(tx[1].Update!.ExpressionAttributeNames!["#spent"]).toBe("spent_CAD");
    expect(tx[1].Update!.ExpressionAttributeValues).toMatchObject({ ":one": 1, ":net": 4000, ":email": "ann@example.com" });
    const latest = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(latest.ConditionExpression).toBe("attribute_not_exists(#last) OR #last <= :paid");
    expect(latest.ExpressionAttributeValues).toMatchObject({ ":name": "Ann Lee", ":phone": "555", ":lcode": "K7Q2XM" });
  });

  it("the same order again: nothing changes (webhook retries, sweeper, backfill)", async () => {
    ddb.on(GetCommand).resolves({ Item: { customerId: CID, currency: "CAD", refundedMinor: 0 } });
    expect(await recordCustomerOrder(order())).toBe("UNCHANGED");
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("a refund takes the difference off; a refund that failed later puts it back", async () => {
    ddb.on(GetCommand).resolvesOnce({ Item: { customerId: CID, currency: "CAD", refundedMinor: 0 } }).resolvesOnce({ Item: { customerId: CID, currency: "CAD", refundedMinor: 1000 } });
    expect(await recordCustomerOrder(order({ storeOrderRefundedMinor: 1000 }))).toBe("UPDATED");
    expect(await recordCustomerOrder(order({ storeOrderRefundedMinor: 0 }))).toBe("UPDATED");
    const [a, b] = ddb.commandCalls(TransactWriteCommand).map((c) => c.args[0].input.TransactItems!);
    expect(a[0].Update!.ConditionExpression).toBe("refundedMinor = :before");
    expect(a[1].Update!.ExpressionAttributeValues).toEqual({ ":delta": -1000 });
    expect(b[1].Update!.ExpressionAttributeValues).toEqual({ ":delta": 1000 });
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0); // no detail rewrite on refunds
  });

  it("unpaid, cancelled, no email or an odd currency: skipped", async () => {
    for (const o of [
      order({ storeOrderStatus: "PENDING_PAYMENT", storeOrderPaidAt: undefined }),
      order({ storeOrderStatus: "CANCELLED" }),
      order({ storeOrderCustomer: { name: "", email: "  ", phone: "" } }),
      order({ storeOrderCurrency: "cad" }),
    ]) expect(await recordCustomerOrder(o)).toBe("SKIPPED");
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
  });

  it("losing a race re-reads and counts once", async () => {
    ddb.on(GetCommand).resolvesOnce({}).resolvesOnce({ Item: { customerId: CID, currency: "CAD", refundedMinor: 0 } });
    ddb.on(TransactWriteCommand).rejectsOnce(Object.assign(new Error("x"), { name: "TransactionCanceledException" }));
    expect(await recordCustomerOrder(order())).toBe("UNCHANGED");
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it("an older order recorded later doesn't replace the newest details", async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(UpdateCommand).rejects(Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }));
    expect(await recordCustomerOrder(order())).toBe("ADDED");
  });
});

describe("listStoreCustomers", () => {
  it("reads every page of CUSTOMER# rows, most recent first, spent per currency", async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ sk: "CUSTOMER#a", customerId: "a", email: "a@x.com", orders: 1, spent_CAD: 100, lastOrderAt: 1 }], LastEvaluatedKey: { pk: "p", sk: "s" } })
      .resolvesOnce({ Items: [{ sk: "CUSTOMER#b", customerId: "b", email: "b@x.com", orders: 2, spent_CAD: 50, spent_USD: 900, lastOrderAt: 5 }] });
    const r = await listStoreCustomers(STORE);
    expect(r.partial).toBe(false);
    expect(r.customers.map((c) => c.email)).toEqual(["b@x.com", "a@x.com"]);
    expect(r.customers[0].spent).toEqual([{ currency: "USD", minor: 900 }, { currency: "CAD", minor: 50 }]);
    expect(ddb.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues![":p"]).toBe("CUSTOMER#");
  });

  it("says partial past the cap", async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ sk: "CUSTOMER#a" }, { sk: "CUSTOMER#b" }], LastEvaluatedKey: { pk: "p", sk: "s" } });
    const r = await listStoreCustomers(STORE, 2);
    expect(r).toMatchObject({ partial: true });
    expect(r.customers).toHaveLength(2);
  });

  it("an old row with missing fields still reads", () => {
    expect(customerFromRow({ sk: "CUSTOMER#abc", firstOrderAt: 7 })).toMatchObject({ customerId: "abc", orders: 0, spent: [], lastOrderAt: 7 });
  });
});

describe("GET /store/customers/list/:storeId", () => {
  const app = createApp();
  it("returns the store's customers, no-store; 500 when the read fails", async () => {
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "sub-1", "cognito:groups": [] } as any);
    ddb.on(QueryCommand).resolves({ Items: [{ sk: "CUSTOMER#a", customerId: "a", email: "a@x.com", orders: 1, spent_CAD: 100 }] });
    const get = () => request(app).get(`/api/v1/store/customers/list/${STORE}`).set("Host", "localhost").set("Authorization", "Bearer t");
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.customers[0].email).toBe("a@x.com");
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    ddb.on(QueryCommand).rejects(new Error("boom"));
    expect((await get()).status).toBe(500);
  });
});
