import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  findUserIdByCognitoId: vi.fn(async () => "USER1"),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getMembership: vi.fn(async (s: string, u: string) => ({ storeId: s, userId: u, role: "MERCHANT", createdAt: 1 })),
  getStoreOverviewRow: vi.fn(async () => ({ storeName: "Northern Hoop", storeSlug: "northern-hoop" })),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/order", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/order")>()),
  getOrderById: vi.fn(),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/store", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/store")>()),
  getPublicStoreSettings: vi.fn(async () => ({ storeInfo: {} })),
}));
vi.mock("../layers/aws/s3/image-upload", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/s3/image-upload")>()),
  markImagesKept: vi.fn(async () => {}),
  createImageUploads: vi.fn(async () => ({ png: [], jpg: [{ key: "k", url: "u", fields: {} }] })),
}));
vi.mock("../layers/notifications/message-notify", () => ({
  notifyStoreOfMessage: vi.fn(async () => {}),
  notifyShopperOfReply: vi.fn(async () => {}),
  sendInquiryLink: vi.fn(async () => {}),
}));
vi.mock("../layers/notifications/admin-alerts", async (orig) => ({
  ...(await orig<typeof import("../layers/notifications/admin-alerts")>()),
  notifyConversationReported: vi.fn(async () => {}),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";
import { StoreOrder } from "../layers/core/interfaces/store";
import { getOrderById, hashStatusToken } from "../layers/aws/dynamodb/dynamo-entities/order";
import { getPublicStoreSettings, StoreRecordNotFoundError } from "../layers/aws/dynamodb/dynamo-entities/store";
import { createImageUploads, markImagesKept } from "../layers/aws/s3/image-upload";
import { notifyShopperOfReply, notifyStoreOfMessage, sendInquiryLink } from "../layers/notifications/message-notify";
import { notifyConversationReported } from "../layers/notifications/admin-alerts";
import { isMessageCursor, isMessageImageKey, previewOf, STORE_EMAIL_DELAY_MS } from "../layers/aws/dynamodb/dynamo-entities/conversation";
import { messageLimits, outgoingMessage } from "../layers/core/messages";

const ddb = mockClient(DynamoDBDocumentClient);
const STORE = "01JBZ0000000000000000000AA";
const ORDER = "01JBZ0000000000000000000RD";
const INQ = "01JBZ0000000000000000000NQ";
const TOKEN = "tok-123";
const IMG = `store/${STORE}/messages/${ORDER}/01JBZ0000000000000000000MG.jpg`;

const order = (over: Partial<StoreOrder> = {}): StoreOrder =>
  ({
    storeOrderId: ORDER,
    storeId: STORE,
    storeOrderCode: "K7Q2XM",
    storeOrderStatus: "PAID",
    storeOrderCreatedAt: 1_700_000_000_000,
    storeOrderPaidAt: 1_700_000_001_000,
    storeOrderStatusTokenHash: hashStatusToken(TOKEN),
    storeOrderCustomer: { name: "Ann Lee", email: "ann@example.com", phone: "" },
    ...over,
  }) as StoreOrder;

const convo = (over: Record<string, unknown> = {}) => ({
  pk: `STORE#${STORE}`,
  sk: `CONVO#${ORDER}`,
  conversationId: ORDER,
  storeId: STORE,
  kind: "ORDER",
  orderId: ORDER,
  orderCode: "K7Q2XM",
  customerName: "Ann Lee",
  customerEmail: "ann@example.com",
  status: "OPEN",
  messageCount: 1,
  lastAt: 1_700_000_100_000,
  lastFrom: "CUSTOMER",
  preview: "Hi",
  storeUnread: 0,
  customerUnread: 0,
  storeReadAt: 0,
  customerReadAt: 0,
  customerEmailedAt: 0,
  createdAt: 1_700_000_100_000,
  report: null,
  customerTokenHashes: [],
  actSk: `CONVO_ACT#1700000100000#${ORDER}`,
  ...over,
});

/** GetCommand answers by sort key. */
function rows(byKey: Record<string, Record<string, unknown> | undefined>) {
  ddb.on(GetCommand).callsFake((input) => ({ Item: byKey[input.Key.sk] }));
}

const app = createApp();
const host = (r: request.Test) => r.set("Host", "localhost");
const auth = (r: request.Test) => host(r).set("Authorization", "Bearer good");
const asAdmin = () => vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "sub-admin", "cognito:groups": ["Admins"] } as any);
const tx = () => ddb.commandCalls(TransactWriteCommand).map((c) => c.args[0].input.TransactItems!);

beforeEach(() => {
  ddb.reset();
  Object.values(messageLimits).forEach((l) => l.reset());
  vi.mocked(getOrderById).mockReset().mockResolvedValue(order());
  vi.mocked(getPublicStoreSettings).mockReset().mockResolvedValue({ storeInfo: {} } as any);
  vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "sub-1", "cognito:groups": [] } as any);
  vi.mocked(markImagesKept).mockClear();
  vi.mocked(notifyShopperOfReply).mockClear();
  vi.mocked(notifyStoreOfMessage).mockClear();
  vi.mocked(sendInquiryLink).mockClear();
  vi.mocked(notifyConversationReported).mockClear();
  ddb.on(TransactWriteCommand).resolves({});
  ddb.on(UpdateCommand).resolves({});
});

describe("message rules (L.10)", () => {
  it("text and/or up to 4 photos from the conversation's own folder", () => {
    expect(outgoingMessage(STORE, ORDER, { body: "  Hi\n\n\n\nthere \u0007 " })).toEqual({ body: "Hi\n\nthere", images: [] });
    expect(outgoingMessage(STORE, ORDER, { images: [IMG, IMG] })).toEqual({ body: "", images: [IMG] });
    expect(outgoingMessage(STORE, ORDER, { body: "   " })).toBeNull();
    expect(outgoingMessage(STORE, ORDER, { body: "x".repeat(2001) })).toBeNull();
    // Another conversation's or store's photo, or a path trick.
    expect(outgoingMessage(STORE, INQ, { images: [IMG] })).toBeNull();
    expect(isMessageImageKey(STORE, ORDER, `store/${STORE}/messages/${ORDER}/../x.jpg`)).toBe(false);
    const five = Array.from({ length: 5 }, (_, i) => `store/${STORE}/messages/${ORDER}/01JBZ000000000000000000${i}MG.jpg`);
    expect(outgoingMessage(STORE, ORDER, { images: five })).toBeNull();
  });

  it("inbox previews and message cursors", () => {
    expect(previewOf("  Is   this\nin stock? ", 0)).toBe("Is this in stock?");
    expect(previewOf("", 1)).toBe("📷 Photo");
    expect(previewOf("", 3)).toBe("📷 3 photos");
    expect(isMessageCursor(ORDER, `CONVO_MSG#${ORDER}#1700000000000#01JBZ0000000000000000000MM`)).toBe(true);
    expect(isMessageCursor(ORDER, `CONVO_MSG#${INQ}#1700000000000#01JBZ0000000000000000000MM`)).toBe(false);
    expect(isMessageCursor(ORDER, `CONVO_MSG#${ORDER}#17#x`)).toBe(false);
  });
});

describe("shopper: Contact us starts a conversation", () => {
  const start = (b: object) => host(request(app).post("/api/v1/customer/messages/start")).send({ storeId: STORE, name: "Ann", email: "Ann@Example.com", body: "Do you ship to BC?", ...b });

  it("saves it with its first message, unread for the store and its email queued; the shopper gets a token and an email", async () => {
    const res = await start({});
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[\w-]{20,}$/);
    expect(res.body.conversation).toMatchObject({ kind: "INQUIRY", storeName: "Northern Hoop", customerName: "Ann", status: "OPEN" });
    expect(res.body.conversation).not.toHaveProperty("customerEmail");
    expect(res.body.messages).toEqual([expect.objectContaining({ from: "CUSTOMER", body: "Do you ship to BC?" })]);
    const [items] = tx();
    expect(items).toHaveLength(5);
    const saved = items[0].Put!.Item!;
    expect(saved).toMatchObject({ kind: "INQUIRY", customerEmail: "ann@example.com", storeUnread: 1, customerTokenHashes: [hashStatusToken(res.body.token)] });
    expect(items[1].Put!.Item!.sk).toMatch(/^CONVO_ACT#\d{13}#/);
    expect(items[3].Put!.Item!.sk).toBe(`CONVO_UNREAD#${res.body.conversationId}`);
    expect(items[4].Put!.Item!.pk).toBe("APP_CONVO_NOTIFY");
    const due = Number(String(items[4].Put!.Item!.sk).slice(0, 13));
    expect(due - saved.createdAt).toBe(STORE_EMAIL_DELAY_MS);
    expect(sendInquiryLink).toHaveBeenCalledOnce();
    expect(notifyStoreOfMessage).toHaveBeenCalledOnce();
  });

  it("honeypot: answers like a send, saves nothing", async () => {
    const res = await start({ website: "http://spam" });
    expect(res.status).toBe(201);
    expect(tx()).toHaveLength(0);
  });

  it("a store that isn't open: 404; bad input: 400; 5 per IP per 10 minutes", async () => {
    vi.mocked(getPublicStoreSettings).mockRejectedValueOnce(new StoreRecordNotFoundError("Store"));
    expect((await start({})).status).toBe(404);
    expect((await start({ email: "nope" })).status).toBe(400);
    expect((await start({ body: "" })).status).toBe(400);
    for (let i = 0; i < 4; i++) await start({});
    expect((await start({})).status).toBe(429);
  });
});

describe("shopper: reading and sending with the token", () => {
  const thread = (id: string, token = TOKEN, q = "") =>
    host(request(app).get(`/api/v1/customer/messages/thread/${STORE}/${id}${q}`)).set("X-Conversation-Token", token);
  const send = (b: object, token = TOKEN) =>
    host(request(app).post("/api/v1/customer/messages/send")).set("X-Conversation-Token", token).send({ storeId: STORE, conversationId: ORDER, ...b });

  it("an order's conversation opens with the order's token; before the first message it's empty", async () => {
    rows({});
    const res = await thread(ORDER);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ conversation: { kind: "ORDER", orderCode: "K7Q2XM", storeName: "Northern Hoop" }, messages: [], older: null });
    expect((await thread(ORDER, "wrong")).status).toBe(404);
    vi.mocked(getOrderById).mockResolvedValue(order({ storeId: "01JBZ0000000000000000000ZZ" }));
    expect((await thread(ORDER)).status).toBe(404);
    vi.mocked(getOrderById).mockResolvedValue(order({ storeOrderPaidAt: undefined }));
    expect((await thread(ORDER)).status).toBe(404);
  });

  it("an inquiry opens with one of its own tokens only (never an order's)", async () => {
    rows({ [`CONVO#${INQ}`]: convo({ conversationId: INQ, kind: "INQUIRY", orderId: null, customerTokenHashes: [hashStatusToken("inq-tok")] }) });
    ddb.on(QueryCommand).resolves({ Items: [] });
    expect((await thread(INQ, "inq-tok")).status).toBe(200);
    expect((await thread(INQ, TOKEN)).status).toBe(404);
  });

  it("pages newest first with an `older` cursor, and `after` polls", async () => {
    rows({ [`CONVO#${ORDER}`]: convo() });
    const msg = (n: number) => ({ pk: `STORE#${STORE}`, sk: `CONVO_MSG#${ORDER}#${String(1_700_000_000_000 + n)}#01JBZ00000000000000000${String(n).padStart(4, "0")}`, messageId: `m${n}`, from: "CUSTOMER", body: `#${n}`, at: n, images: [] });
    ddb.on(QueryCommand).resolves({ Items: Array.from({ length: 31 }, (_, i) => msg(40 - i)) });
    const res = await thread(ORDER);
    expect(res.body.messages).toHaveLength(30);
    expect(res.body.older).toBe(msg(11).sk);
    const q = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(q.ScanIndexForward).toBe(false);
    ddb.on(QueryCommand).resolves({ Items: [msg(40), msg(41)] });
    const polled = await thread(ORDER, TOKEN, `?after=${encodeURIComponent(msg(40).sk)}`);
    expect(polled.body.messages.map((m: { body: string }) => m.body)).toEqual(["#41"]);
    expect((await thread(ORDER, TOKEN, "?before=CONVO_MSG%23x")).status).toBe(400);
  });

  it("the first message on an order starts its conversation (id = the order's)", async () => {
    rows({});
    const res = await send({ body: "Where's my parcel?", images: [IMG] });
    expect(res.status).toBe(201);
    expect(markImagesKept).toHaveBeenCalledWith([IMG]);
    const [items] = tx();
    expect(items[0].Put!.Item).toMatchObject({ sk: `CONVO#${ORDER}`, kind: "ORDER", orderCode: "K7Q2XM", customerEmail: "ann@example.com" });
    expect(items[2].Put!.Item).toMatchObject({ from: "CUSTOMER", authorName: "Ann Lee", images: [IMG] });
    expect(notifyStoreOfMessage).toHaveBeenCalledOnce();
  });

  it("a reply moves the inbox row, marks it unread for the store and queues the store's email only once", async () => {
    rows({ [`CONVO#${ORDER}`]: convo({ storeUnread: 0 }) });
    await send({ body: "Hello?" });
    let [items] = tx();
    expect(items[0].Update!.ConditionExpression).toContain("actSk = :oldAct");
    expect(items[1].Delete!.Key).toEqual({ pk: `STORE#${STORE}`, sk: `CONVO_ACT#1700000100000#${ORDER}` });
    expect(items[2].Put!.Item!.sk).toMatch(/^CONVO_ACT#/);
    expect(items[4].Update!.Key).toEqual({ pk: `STORE#${STORE}`, sk: `CONVO_UNREAD#${ORDER}` });
    expect(items[5].Put!.Item!.pk).toBe("APP_CONVO_NOTIFY");
    ddb.resetHistory();
    rows({ [`CONVO#${ORDER}`]: convo({ storeUnread: 2 }) });
    await send({ body: "Hello??" });
    [items] = tx();
    expect(items).toHaveLength(5);
  });

  it("blocked: 409 CONVERSATION_CLOSED; wrong token: 404; nothing to send: 400", async () => {
    rows({ [`CONVO#${ORDER}`]: convo({ status: "BLOCKED" }) });
    expect((await send({ body: "x" })).body.code).toBe("CONVERSATION_CLOSED");
    expect((await send({ body: "x" }, "wrong")).status).toBe(404);
    expect((await send({ body: " " })).status).toBe(400);
    expect(tx()).toHaveLength(0);
  });

  it("read clears the shopper's unread; photo upload slots need the token", async () => {
    rows({ [`CONVO#${ORDER}`]: convo({ customerUnread: 2 }) });
    const r = await host(request(app).post("/api/v1/customer/messages/read")).set("X-Conversation-Token", TOKEN).send({ storeId: STORE, conversationId: ORDER });
    expect(r.body).toEqual({ read: true });
    expect(ddb.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues).toMatchObject({ ":zero": 0 });
    const up = (t: string) => host(request(app).get(`/api/v1/customer/messages/image-upload-urls/${STORE}/${ORDER}/0/1`)).set("X-Conversation-Token", t);
    expect((await up(TOKEN)).status).toBe(200);
    expect(createImageUploads).toHaveBeenCalledWith(`store/${STORE}/messages/${ORDER}/`, 0, 1);
    expect((await up("wrong")).status).toBe(404);
  });
});

describe("store: inbox, reading, replying, reporting", () => {
  it("the inbox: newest activity first, a page and a cursor, with the unread count", async () => {
    ddb.on(QueryCommand).callsFake((input) =>
      input.Select === "COUNT"
        ? { Count: 1 }
        : { Items: [{ conversationId: ORDER }, { conversationId: INQ }], LastEvaluatedKey: { pk: "x", sk: `CONVO_ACT#1700000000000#${INQ}` } }
    );
    ddb.on(BatchGetCommand).resolves({
      Responses: { [Object.keys({})[0] ?? "ceseelia_dev"]: [] },
    });
    ddb.on(BatchGetCommand).callsFake((input) => {
      const table = Object.keys(input.RequestItems)[0];
      return { Responses: { [table]: [convo({ lastAt: 1 }), convo({ conversationId: INQ, sk: `CONVO#${INQ}`, kind: "INQUIRY", lastAt: 2, customerTokenHashes: ["secret"] })] } };
    });
    const res = await auth(request(app).get(`/api/v1/store/messages/list/${STORE}`));
    expect(res.status).toBe(200);
    expect(res.body.conversations.map((c: { conversationId: string }) => c.conversationId)).toEqual([INQ, ORDER]);
    expect(res.body.conversations[0]).not.toHaveProperty("customerTokenHashes");
    expect(res.body).toMatchObject({ next: `CONVO_ACT#1700000000000#${INQ}`, unread: 1 });
    const q = ddb.commandCalls(QueryCommand).find((c) => c.args[0].input.Select !== "COUNT")!.args[0].input;
    expect(q.ExpressionAttributeValues).toMatchObject({ ":p": "CONVO_ACT#" });
    await auth(request(app).get(`/api/v1/store/messages/list/${STORE}?filter=unread`));
    expect(ddb.commandCalls(QueryCommand).some((c) => c.args[0].input.ExpressionAttributeValues?.[":p"] === "CONVO_UNREAD#")).toBe(true);
    expect((await auth(request(app).get(`/api/v1/store/messages/list/${STORE}?cursor=junk`))).status).toBe(400);
  });

  it("an order with no conversation yet: the merchant can still open it and write first", async () => {
    rows({});
    const res = await auth(request(app).get(`/api/v1/store/messages/thread/${STORE}/${ORDER}`));
    expect(res.body).toMatchObject({ conversation: null, order: { orderCode: "K7Q2XM", customerName: "Ann Lee" } });
    const sent = await auth(request(app).post("/api/v1/store/messages/send")).send({ storeId: STORE, conversationId: ORDER, body: "It shipped today!" });
    expect(sent.status).toBe(201);
    const [items] = tx();
    expect(items[0].Put!.Item).toMatchObject({ kind: "ORDER", customerUnread: 1, storeUnread: 0 });
    expect(items[2].Put!.Item).toMatchObject({ from: "STORE", authorName: "Northern Hoop", byUserId: "USER1" });
    expect(items).toHaveLength(3); // no unread row or email for the store's own message
    expect(notifyShopperOfReply).toHaveBeenCalledOnce();
    expect(sent.body.message).not.toHaveProperty("byUserId");
  });

  it("replying reads the shopper's messages; someone else's order is 404", async () => {
    rows({ [`CONVO#${ORDER}`]: convo({ storeUnread: 3 }) });
    await auth(request(app).post("/api/v1/store/messages/send")).send({ storeId: STORE, conversationId: ORDER, body: "Yes!" });
    const [items] = tx();
    expect(items[0].Update!.UpdateExpression).toContain("storeUnread = :zero");
    expect(items[4].Delete!.Key).toEqual({ pk: `STORE#${STORE}`, sk: `CONVO_UNREAD#${ORDER}` });
    rows({});
    vi.mocked(getOrderById).mockResolvedValue(order({ storeId: "01JBZ0000000000000000000ZZ" }));
    expect((await auth(request(app).post("/api/v1/store/messages/send")).send({ storeId: STORE, conversationId: ORDER, body: "x" })).status).toBe(404);
  });

  it("read: a member marks it read; a platform admin reading a report doesn't", async () => {
    rows({ [`CONVO#${ORDER}`]: convo({ storeUnread: 1 }) });
    const r = await auth(request(app).post("/api/v1/store/messages/read")).send({ storeId: STORE, conversationId: ORDER });
    expect(r.body).toEqual({ read: true });
    expect(tx()[0][1].Delete!.Key).toEqual({ pk: `STORE#${STORE}`, sk: `CONVO_UNREAD#${ORDER}` });
    ddb.resetHistory();
    asAdmin();
    expect((await auth(request(app).post("/api/v1/store/messages/read")).send({ storeId: STORE, conversationId: ORDER })).body).toEqual({ read: false });
    expect(tx()).toHaveLength(0);
  });

  it("report: once, a note for OTHER, and the admins hear about it", async () => {
    rows({ [`CONVO#${ORDER}`]: convo() });
    const report = (b: object) => auth(request(app).post("/api/v1/store/messages/report")).send({ storeId: STORE, conversationId: ORDER, ...b });
    expect((await report({ reason: "OTHER" })).body.code).toBe("NOTE_REQUIRED");
    expect((await report({ reason: "SPAM" })).body).toEqual({ reported: true });
    const [items] = tx();
    expect(items[1].Put!.Item).toMatchObject({ pk: "APP_CONVO_REPORT", reason: "SPAM", storeName: "Northern Hoop" });
    expect(notifyConversationReported).toHaveBeenCalledWith(STORE, "Northern Hoop", "SPAM");
    ddb.on(TransactWriteCommand).rejects(Object.assign(new Error("x"), { name: "TransactionCanceledException" }));
    expect((await report({ reason: "SPAM" })).body.code).toBe("ALREADY_REPORTED");
  });

  it("admins decide a report: BLOCK closes it; nothing open → 409", async () => {
    asAdmin();
    const decide = (decision: string) => auth(request(app).post("/api/v1/admin/decide-message-report")).send({ storeId: STORE, conversationId: ORDER, decision });
    expect((await decide("BLOCK")).body).toEqual({ decision: "BLOCK" });
    const [items] = tx();
    expect(items[0].Delete!.Key).toEqual({ pk: "APP_CONVO_REPORT", sk: `STORE#${STORE}#CONVO#${ORDER}` });
    expect(items[1].Update!.ExpressionAttributeValues).toMatchObject({ ":blocked": "BLOCKED", ":d": "BLOCK" });
    expect((await decide("MAYBE")).status).toBe(400);
    ddb.on(TransactWriteCommand).rejects(Object.assign(new Error("x"), { name: "TransactionCanceledException" }));
    rows({ [`CONVO#${ORDER}`]: convo() });
    expect((await decide("DISMISS")).body.code).toBe("REPORT_CHANGED");
  });
});
