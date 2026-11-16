import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

vi.mock("../layers/notifications/order-emails", () => ({
  storeFor: vi.fn(),
  send: vi.fn(async () => true),
  shopperFrom: (s: { storeName: string }) => `${s.storeName} via Ceseelia`,
}));
vi.mock("../layers/notifications/web-push", () => ({ pushToUser: vi.fn(async () => 1) }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  listStoreMembers: vi.fn(async () => [
    { userId: "U1", email: "Owner@Shop.test", role: "ADMIN" },
    { userId: "U2", email: "helper@shop.test", role: "MERCHANT" },
  ]),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/order", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/order")>()),
  getOrderById: vi.fn(),
  addOrderLinkTokenHash: vi.fn(async () => {}),
}));

import { send, storeFor } from "../layers/notifications/order-emails";
import { pushToUser } from "../layers/notifications/web-push";
import { addOrderLinkTokenHash, getOrderById } from "../layers/aws/dynamodb/dynamo-entities/order";
import { notifyShopperOfReply, notifyStoreOfMessage, sweepMessageEmails } from "../layers/notifications/message-notify";
import { Conversation } from "../layers/aws/dynamodb/dynamo-entities/conversation";

const ddb = mockClient(DynamoDBDocumentClient);
const STORE = "01JBZ0000000000000000000AA";
const ORDER = "01JBZ0000000000000000000RD";
const INQ = "01JBZ0000000000000000000NQ";

const store = (over = {}) => ({
  storeName: "Northern Hoop",
  storeEmail: "hello@shop.test",
  pickupAddress: "",
  taxNumber: "",
  emailOrderAlerts: true,
  emailMessageAlerts: true,
  storeSlug: "northern-hoop",
  ...over,
});

const convo = (over: Partial<Conversation> = {}): Conversation => ({
  conversationId: ORDER,
  storeId: STORE,
  kind: "ORDER",
  orderId: ORDER,
  orderCode: "K7Q2XM",
  customerName: "Ann Lee",
  customerEmail: "ann@example.com",
  status: "OPEN",
  messageCount: 2,
  lastAt: 5,
  lastFrom: "STORE",
  preview: "It shipped",
  storeUnread: 0,
  customerUnread: 1,
  storeReadAt: 5,
  customerReadAt: 0,
  customerEmailedAt: 0,
  createdAt: 1,
  report: null,
  customerTokenHashes: [],
  actSk: `CONVO_ACT#0000000000005#${ORDER}`,
  ...over,
});

beforeEach(() => {
  ddb.reset();
  vi.mocked(send).mockClear();
  vi.mocked(pushToUser).mockClear();
  vi.mocked(storeFor).mockReset().mockResolvedValue(store());
  vi.mocked(getOrderById).mockReset().mockResolvedValue({ storeOrderId: ORDER, storeId: STORE, storeOrderCreatedAt: 1 } as any);
  vi.mocked(addOrderLinkTokenHash).mockClear();
});

describe("message notifications (L.10)", () => {
  it("a shopper message pushes to every member, linking to the conversation", async () => {
    await notifyStoreOfMessage(convo({ preview: "Where is it?" }), "Northern Hoop");
    expect(pushToUser).toHaveBeenCalledTimes(2);
    expect(vi.mocked(pushToUser).mock.calls[0][1]).toMatchObject({
      title: "New message · Northern Hoop",
      body: "Ann Lee · order #K7Q2XM: Where is it?",
      url: `/store/messages/${STORE}?c=${ORDER}`,
    });
  });

  it("a store reply emails the shopper a fresh order link, once until they've read it", async () => {
    ddb.on(UpdateCommand).resolves({});
    await notifyShopperOfReply(convo());
    const claim = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(claim.ConditionExpression).toContain("customerEmailedAt <= customerReadAt");
    expect(addOrderLinkTokenHash).toHaveBeenCalledOnce();
    const [to, from, email] = vi.mocked(send).mock.calls[0];
    expect([to, from]).toEqual(["ann@example.com", "Northern Hoop via Ceseelia"]);
    expect(email.subject).toBe("Northern Hoop replied to you about order #K7Q2XM");
    expect(email.html).toMatch(new RegExp(`/order/${ORDER}\\?messages=1#t=[\\w-]+`));
    expect(email.html).not.toContain("It shipped"); // no message text in emails

    vi.mocked(send).mockClear();
    ddb.on(UpdateCommand).rejects(Object.assign(new Error("c"), { name: "ConditionalCheckFailedException" }));
    await notifyShopperOfReply(convo());
    expect(send).not.toHaveBeenCalled();
  });

  it("an inquiry's reply link is a new token on the conversation", async () => {
    ddb.on(UpdateCommand).resolves({});
    ddb.on(GetCommand).resolves({ Item: { ...convo({ conversationId: INQ, kind: "INQUIRY", orderId: null, orderCode: null, customerTokenHashes: ["a"] }) } });
    await notifyShopperOfReply(convo({ conversationId: INQ, kind: "INQUIRY", orderId: null, orderCode: null }));
    const tokenWrite = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input).find((i) => i.UpdateExpression === "SET customerTokenHashes = :next")!;
    expect((tokenWrite.ExpressionAttributeValues![":next"] as string[]).length).toBe(2);
    const email = vi.mocked(send).mock.calls[0][2];
    expect(email.html).toMatch(new RegExp(`/messages/${INQ}#t=[\\w-]+`));
  });

  it("the sweep: still unread after 30 minutes → one email to members and the store; read, blocked or turned off → none", async () => {
    const due = (id: string) => ({ pk: "APP_CONVO_NOTIFY", sk: `0000000000001#STORE#${STORE}#${id}`, storeId: STORE, conversationId: id });
    ddb.on(QueryCommand).resolves({ Items: [due(ORDER), due(INQ)] });
    ddb.on(GetCommand).callsFake((input) => ({
      Item: input.Key.sk === `CONVO#${ORDER}` ? convo({ storeUnread: 2 }) : convo({ conversationId: INQ, storeUnread: 0 }),
    }));
    ddb.on(DeleteCommand).resolves({});
    const r = await sweepMessageEmails(1_000);
    expect(r).toEqual({ sent: 1, skipped: 1, failed: 0 });
    expect(vi.mocked(send).mock.calls.map((c) => c[0]).sort()).toEqual(["hello@shop.test", "helper@shop.test", "owner@shop.test"]);
    expect(vi.mocked(send).mock.calls[0][2].subject).toBe("New message from Ann Lee about order #K7Q2XM");
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(2);

    vi.mocked(send).mockClear();
    vi.mocked(storeFor).mockResolvedValue(store({ emailMessageAlerts: false }));
    expect(await sweepMessageEmails(1_000)).toEqual({ sent: 0, skipped: 2, failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});
