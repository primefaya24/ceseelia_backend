import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

import { createApp } from "../app";
import { orderStatusLimit } from "../api/v1/customer/order-status";
import { hashStatusToken, newStatusToken } from "../layers/aws/dynamodb/dynamo-entities/order";

const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = "01JBZ0000000000000000000AA";
const ORDER_ID = "01JBZ0000000000000000000RD";
const SK = `ORDER#1#${ORDER_ID}`;
const { token, hash } = newStatusToken();

function world(exists = true) {
  ddb.on(GetCommand).callsFake((input) => {
    const { pk, sk } = input.Key;
    if (!exists) return {};
    if (pk === `ORDER#${ORDER_ID}`) return { Item: { pk, sk, storeId: STORE, orderSk: SK } };
    if (pk === `STORE#${STORE}`)
      return {
        Item: {
          pk,
          sk,
          storeOrderId: ORDER_ID,
          storeId: STORE,
          storeOrderCode: "K7Q2XM",
          storeOrderStatus: "PAID",
          storeOrderTotalMinor: 3024,
          storeOrderPlatformFeeMinor: 145,
          storeOrderCommission: { source: "PLAN" },
          storeOrderStripe: { accountId: "acct_x", checkoutSessionId: "cs_1", paymentIntentId: "pi_1" },
          storeOrderStatusTokenHash: hash,
          storeOrderLines: [],
        },
      };
    if (pk === "APP_STORE") return { Item: { storeName: "Northern Hoop", storeSlug: "northern-hoop" } };
    return {};
  });
}
const get = (t?: string, id = ORDER_ID) => {
  const r = request(app).get(`/api/v1/customer/order-status/${id}`).set("Host", "localhost");
  return t === undefined ? r : r.set("X-Order-Token", t);
};

beforeEach(() => {
  ddb.reset();
  orderStatusLimit.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /customer/order-status/:orderId (6.4)", () => {
  it("the right token gets the shopper's view: no Stripe ids, fee, commission or hash", async () => {
    world();
    const res = await get(token);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ orderId: ORDER_ID, orderCode: "K7Q2XM", status: "PAID", totalMinor: 3024, storeSlug: "northern-hoop" });
    const text = JSON.stringify(res.body);
    for (const secret of ["acct_x", "cs_1", "pi_1", "145", hash, "Commission"]) expect(text).not.toContain(secret);
  });

  it("a wrong token and an unknown order are the same 404", async () => {
    world();
    const wrong = await get("x".repeat(32));
    world(false);
    const unknown = await get(token);
    expect([wrong.status, wrong.body.code]).toEqual([404, "ORDER_NOT_FOUND"]);
    expect(unknown.body).toEqual(wrong.body);
  });

  it("400 without a token, with an oversized one, or a bad id", async () => {
    world();
    expect((await get()).status).toBe(400);
    expect((await get("x".repeat(65))).status).toBe(400);
    expect((await get(token, "nope")).status).toBe(400);
  });

  it("60 per IP per minute", async () => {
    world();
    for (let i = 0; i < 60; i++) await get(token);
    expect((await get(token)).status).toBe(429);
  });

  it("the stored hash is SHA-256 of the token", () => {
    expect(hashStatusToken(token)).toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
