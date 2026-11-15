import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  findUserIdByCognitoId: vi.fn(async () => "USER1"),
  fetchUserUUID: vi.fn(async () => "USER1"),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getMembership: vi.fn(async (s: string, u: string) => ({ storeId: s, userId: u, role: "MERCHANT", createdAt: 1 })),
  listStoreMembers: vi.fn(async () => [
    { userId: "U1", firstName: "", lastName: "", email: "a@x.com", role: "ADMIN", createdAt: 1 },
    { userId: "U2", firstName: "", lastName: "", email: "b@x.com", role: "MERCHANT", createdAt: 2 },
  ]),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";
import { StoreOrder } from "../layers/core/interfaces/store";
import { ORDER_ALERT_TTL_S, putOrderAlert, listOrderAlertsSince } from "../layers/aws/dynamodb/dynamo-entities/order-alert";
import { MAX_PUSH_SUBSCRIPTIONS, pushSubscriptionId, savePushSubscription } from "../layers/aws/dynamodb/dynamo-entities/push";
import {
  isAllowedPushEndpoint,
  pushToUser,
  resetPushKeysForTests,
  setPushSenderForTests,
} from "../layers/notifications/web-push";
import { alertNewOrder, newOrderPush } from "../layers/notifications/order-alerts";
import { NEW_ORDERS_MAX_LOOKBACK_MS } from "../api/v1/store/orders/new/index";
import { resetPushLimitsForTests } from "../api/v1/user/push/shared";

const ddb = mockClient(DynamoDBDocumentClient);
const STORE = "01JBZ0000000000000000000AA";
const ORDER = "01JBZ0000000000000000000OO";
const KEYS = { publicKey: "BPUBLIC", privateKey: "PRIVATE" };
const FCM = "https://fcm.googleapis.com/fcm/send/abc123";
const P256 = "B" + "a".repeat(86);
const AUTH = "b".repeat(22);

const order = (over: Partial<StoreOrder> = {}): StoreOrder =>
  ({
    storeOrderId: ORDER,
    storeId: STORE,
    storeOrderCode: "K7Q2XM",
    storeOrderType: "PICKUP",
    storeOrderCurrency: "CAD",
    storeOrderTotalMinor: 4550,
    storeOrderPaidAt: 1_700_000_000_000,
    storeOrderCustomer: { name: "Ann", email: "ann@example.com", phone: "" },
    ...over,
  }) as StoreOrder;

beforeEach(() => {
  ddb.reset();
  resetPushKeysForTests(KEYS);
  setPushSenderForTests(null);
  resetPushLimitsForTests();
  vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "sub-1", "cognito:groups": [] } as any);
});

describe("order alert rows (L.5)", () => {
  it("writes ids, code and total only, sorted by write time, with a week's TTL", async () => {
    ddb.on(PutCommand).resolves({});
    await putOrderAlert(order(), 1_700_000_000_123);
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item.pk).toBe(`STORE#${STORE}`);
    expect(item.sk).toBe(`ORDER_ALERT#1700000000123#${ORDER}`);
    expect(item.ttl).toBe(1_700_000_000 + ORDER_ALERT_TTL_S);
    expect(item).toMatchObject({ orderCode: "K7Q2XM", totalMinor: 4550, currency: "CAD", orderType: "PICKUP" });
    expect(JSON.stringify(item)).not.toContain("ann@example.com");
    expect(JSON.stringify(item)).not.toContain("Ann");
  });

  it("lists rows after `since`, newest first", async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ orderId: ORDER, orderCode: "K7Q2XM", totalMinor: 1, currency: "CAD", orderType: "PICKUP", paidAt: 5, at: 6 }] });
    const rows = await listOrderAlertsSince(STORE, 1000);
    const input = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues).toMatchObject({ ":from": "ORDER_ALERT#0000000001001", ":to": "ORDER_ALERT#~" });
    expect(input.ScanIndexForward).toBe(false);
    expect(rows[0]).toEqual({ orderId: ORDER, orderCode: "K7Q2XM", totalMinor: 1, currency: "CAD", orderType: "PICKUP", paidAt: 5, at: 6 });
  });
});

describe("push endpoints allowed (the server POSTs to them)", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/x",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://web.push.apple.com/QG/x",
    "https://wns2-par02p.notify.windows.com/w/?token=x",
  ])("accepts %s", (u) => expect(isAllowedPushEndpoint(u)).toBe(true));

  it.each([
    "http://fcm.googleapis.com/fcm/send/x",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/x",
    "https://fcm.googleapis.com.evil.example/x",
    "https://evilgoogleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://user:pw@fcm.googleapis.com/x",
    "not a url",
  ])("refuses %s", (u) => expect(isAllowedPushEndpoint(u)).toBe(false));
});

describe("pushToUser", () => {
  const subs = (endpoints: string[]) =>
    ddb.on(QueryCommand).resolves({ Items: endpoints.map((e, i) => ({ endpoint: e, p256dh: P256, auth: AUTH, createdAt: i })) });

  it("sends to each browser and deletes the ones the push service says are gone", async () => {
    subs([FCM, "https://updates.push.services.mozilla.com/wpush/v2/gone"]);
    ddb.on(DeleteCommand).resolves({});
    const sent: string[] = [];
    setPushSenderForTests(async (sub) => {
      sent.push(sub.endpoint);
      if (sub.endpoint.includes("gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      return { statusCode: 201, body: "", headers: {} };
    });
    expect(await pushToUser("U1", { title: "t", body: "b", url: "/" })).toBe(1);
    expect(sent).toHaveLength(2);
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(1);
    expect(ddb.commandCalls(DeleteCommand)[0].args[0].input.Key!.sk).toBe(
      `PUSH#${pushSubscriptionId("https://updates.push.services.mozilla.com/wpush/v2/gone")}`
    );
  });

  it("never sends to an endpoint that isn't a push service, and drops it", async () => {
    subs(["https://169.254.169.254/x"]);
    ddb.on(DeleteCommand).resolves({});
    const send = vi.fn();
    setPushSenderForTests(send);
    expect(await pushToUser("U1", { title: "t", body: "b", url: "/" })).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(1);
  });

  it("does nothing without VAPID keys", async () => {
    resetPushKeysForTests(null);
    const send = vi.fn();
    setPushSenderForTests(send);
    expect(await pushToUser("U1", { title: "t", body: "b", url: "/" })).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });
});

describe("alertNewOrder", () => {
  it("writes the row and pushes every member; the push has no shopper details", async () => {
    ddb.on(PutCommand).resolves({});
    ddb.on(QueryCommand).resolves({ Items: [{ endpoint: FCM, p256dh: P256, auth: AUTH, createdAt: 1 }] });
    const payloads: string[] = [];
    setPushSenderForTests(async (_s, p) => {
      payloads.push(String(p));
      return { statusCode: 201, body: "", headers: {} };
    });
    await alertNewOrder(order({ storeOrderType: "DELIVERY" }), "Northern Hoop");
    expect(ddb.commandCalls(PutCommand)).toHaveLength(1);
    expect(payloads).toHaveLength(2); // U1 and U2, one browser each
    const p = JSON.parse(payloads[0]);
    expect(p).toMatchObject({ title: "New order · Northern Hoop", url: `/store/orders/${STORE}?order=${ORDER}`, tag: `order-${ORDER}` });
    expect(p.body).toMatch(/^#K7Q2XM · \$45\.50 · Delivery$/);
    expect(payloads[0]).not.toContain("Ann");
  });

  it("never throws when DynamoDB is down", async () => {
    ddb.on(PutCommand).rejects(new Error("down"));
    ddb.on(QueryCommand).rejects(new Error("down"));
    await expect(alertNewOrder(order(), "S")).resolves.toBeUndefined();
  });

  it("newOrderPush without a store name", () => {
    expect(newOrderPush(order(), "").title).toBe("New order");
  });
});

describe("savePushSubscription", () => {
  it("keeps at most MAX_PUSH_SUBSCRIPTIONS, dropping the oldest others", async () => {
    ddb.on(PutCommand).resolves({});
    ddb.on(DeleteCommand).resolves({});
    const items = Array.from({ length: MAX_PUSH_SUBSCRIPTIONS + 2 }, (_, i) => ({
      endpoint: `${FCM}/${i}`,
      p256dh: P256,
      auth: AUTH,
      createdAt: i,
    }));
    ddb.on(QueryCommand).resolves({ Items: items });
    await savePushSubscription("U1", { endpoint: `${FCM}/11`, p256dh: P256, auth: AUTH }, 99);
    const deleted = ddb.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key!.sk);
    expect(deleted).toEqual([`PUSH#${pushSubscriptionId(`${FCM}/0`)}`, `PUSH#${pushSubscriptionId(`${FCM}/1`)}`]);
  });
});

describe("GET /store/orders/new/:storeId", () => {
  const app = createApp();
  const get = (q = "") => request(app).get(`/api/v1/store/orders/new/${STORE}${q}`).set("Host", "localhost").set("Authorization", "Bearer t");

  it("without `since`: no orders, just the server's time", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.orders).toEqual([]);
    expect(typeof res.body.now).toBe("number");
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("with `since`: the alerts after it; a very old `since` is cut to a day", async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ orderId: ORDER, orderCode: "C", totalMinor: 1, currency: "CAD", orderType: "PICKUP", paidAt: 1, at: 2 }] });
    const res = await get("?since=5");
    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    const from = String(ddb.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues![":from"]);
    expect(Number(from.split("#")[1])).toBeGreaterThan(Date.now() - NEW_ORDERS_MAX_LOOKBACK_MS - 5000);
  });

  it("400 for a bad `since`", async () => {
    expect((await get("?since=abc")).status).toBe(400);
  });
});

describe("/user/push routes", () => {
  const app = createApp();
  const post = (path: string, body: object = {}) =>
    request(app).post(`/api/v1/user/push/${path}`).set("Host", "localhost").set("Authorization", "Bearer t").send(body);

  it("config: the public key, or null without keys", async () => {
    const res = await request(app).get("/api/v1/user/push/config").set("Host", "localhost").set("Authorization", "Bearer t");
    expect(res.body).toEqual({ publicKey: "BPUBLIC" });
    resetPushKeysForTests(null);
    const off = await request(app).get("/api/v1/user/push/config").set("Host", "localhost").set("Authorization", "Bearer t");
    expect(off.body).toEqual({ publicKey: null });
  });

  it("subscribe: saves a push-service endpoint", async () => {
    ddb.on(PutCommand).resolves({});
    ddb.on(QueryCommand).resolves({ Items: [] });
    const res = await post("subscribe", { endpoint: FCM, keys: { p256dh: P256, auth: AUTH } });
    expect(res.status).toBe(200);
    expect(ddb.commandCalls(PutCommand)[0].args[0].input.Item).toMatchObject({ pk: "USER#USER1", endpoint: FCM });
  });

  it("subscribe: 400 PUSH_ENDPOINT_NOT_ALLOWED for anything else; 400 for bad keys; 503 without VAPID keys", async () => {
    const bad = await post("subscribe", { endpoint: "https://169.254.169.254/x", keys: { p256dh: P256, auth: AUTH } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("PUSH_ENDPOINT_NOT_ALLOWED");
    expect((await post("subscribe", { endpoint: FCM, keys: { p256dh: "x", auth: AUTH } })).status).toBe(400);
    resetPushKeysForTests(null);
    const off = await post("subscribe", { endpoint: FCM, keys: { p256dh: P256, auth: AUTH } });
    expect(off.status).toBe(503);
    expect(off.body.code).toBe("PUSH_NOT_CONFIGURED");
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("unsubscribe: deletes that browser's row", async () => {
    ddb.on(DeleteCommand).resolves({});
    expect((await post("unsubscribe", { endpoint: FCM })).status).toBe(200);
    expect(ddb.commandCalls(DeleteCommand)[0].args[0].input.Key).toEqual({ pk: "USER#USER1", sk: `PUSH#${pushSubscriptionId(FCM)}` });
  });

  it("test: sends to the user's browsers; 5 per 10 minutes", async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ endpoint: FCM, p256dh: P256, auth: AUTH, createdAt: 1 }] });
    setPushSenderForTests(async () => ({ statusCode: 201, body: "", headers: {} }));
    const res = await post("test");
    expect(res.body).toEqual({ delivered: 1 });
    for (let i = 0; i < 4; i++) await post("test");
    const limited = await post("test");
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
  });

  it("every push route needs a signed-in user", async () => {
    for (const path of ["subscribe", "unsubscribe", "test"]) {
      expect((await request(app).post(`/api/v1/user/push/${path}`).set("Host", "localhost").send({})).status).toBe(401);
    }
    expect((await request(app).get("/api/v1/user/push/config").set("Host", "localhost")).status).toBe(401);
  });
});
