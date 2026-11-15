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
  getStoreOverviewRow: vi.fn(async () => ({ storeName: "Northern Hoop", storeSlug: "northern-hoop" })),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/order", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/order")>()),
  getOrderById: vi.fn(),
}));
vi.mock("../layers/notifications/admin-alerts", () => ({ notifyReviewReported: vi.fn(async () => {}) }));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";
import { StoreOrder } from "../layers/core/interfaces/store";
import { getOrderById, hashStatusToken } from "../layers/aws/dynamodb/dynamo-entities/order";
import { notifyReviewReported } from "../layers/notifications/admin-alerts";
import {
  REVIEW_AFTER_PAID_MS,
  cleanReviewText,
  reviewAuthorName,
  reviewableState,
  statsFromRow,
} from "../layers/aws/dynamodb/dynamo-entities/review";
import { reviewPostLimit, reviewReadLimit } from "../api/v1/customer/review/index";

const ddb = mockClient(DynamoDBDocumentClient);
const STORE = "01JBZ0000000000000000000AA";
const ORDER = "01JBZ0000000000000000000RD";
const TOKEN = "tok-123";
const SK = `REVIEW#1700000000000#${ORDER}`;

const order = (over: Partial<StoreOrder> = {}): StoreOrder =>
  ({
    storeOrderId: ORDER,
    storeId: STORE,
    storeOrderCode: "K7Q2XM",
    storeOrderStatus: "COMPLETED",
    storeOrderCurrency: "CAD",
    storeOrderTotalMinor: 4550,
    storeOrderPaidAt: Date.now() - 1000,
    storeOrderStatusTokenHash: hashStatusToken(TOKEN),
    storeOrderCustomer: { name: "Ann Marie Lee", email: "ann@example.com", phone: "555" },
    storeOrderLines: [{ itemName: "Hoop earrings" }, { itemName: "Hoop earrings" }, { itemName: "Ring" }],
    ...over,
  }) as StoreOrder;

const review = (over: Record<string, unknown> = {}) => ({
  pk: `STORE#${STORE}`,
  sk: SK,
  storeId: STORE,
  orderId: ORDER,
  rating: 2,
  comment: "Late",
  authorName: "Ann L.",
  items: ["Ring"],
  createdAt: 1_700_000_000_000,
  status: "PUBLISHED",
  ...over,
});

const app = createApp();
const host = (r: request.Test) => r.set("Host", "localhost");

beforeEach(() => {
  ddb.reset();
  reviewPostLimit.reset?.();
  reviewReadLimit.reset?.();
  vi.mocked(getOrderById).mockReset().mockResolvedValue(order());
  vi.mocked(notifyReviewReported).mockClear();
  vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "sub-1", "cognito:groups": [] } as any);
});

describe("review rules (L.7 / 7.5)", () => {
  it("ready, shipped or completed orders; others 14 days after payment; never unpaid, cancelled or refunded", () => {
    const now = Date.now();
    for (const s of ["READY", "SHIPPED", "COMPLETED"] as const) expect(reviewableState(order({ storeOrderStatus: s }), now)).toBe("OK");
    expect(reviewableState(order({ storeOrderStatus: "PAID", storeOrderPaidAt: now - 1000 }), now)).toBe("NOT_YET");
    expect(reviewableState(order({ storeOrderStatus: "PREPARING", storeOrderPaidAt: now - REVIEW_AFTER_PAID_MS }), now)).toBe("OK");
    for (const s of ["PENDING_PAYMENT", "CANCELLED", "REFUNDED"] as const) expect(reviewableState(order({ storeOrderStatus: s }), now)).toBe("NOT_REVIEWABLE");
  });

  it("shows first name and last initial only; cleans the text", () => {
    expect(reviewAuthorName("Ann Marie Lee")).toBe("Ann L.");
    expect(reviewAuthorName("  cher ")).toBe("cher");
    expect(reviewAuthorName("")).toBe("Verified buyer");
    expect(cleanReviewText(" Great\u0007\r\n\r\n\r\n\r\nshop‮ ")).toBe("Great\n\nshop");
  });

  it("stats: average to one decimal, per-star counts", () => {
    expect(statsFromRow({ count: 3, sum: 13, r4: 1, r5: 2 })).toEqual({ count: 3, average: 4.3, distribution: [0, 0, 0, 1, 2] });
    expect(statsFromRow(undefined)).toEqual({ count: 0, average: null, distribution: [0, 0, 0, 0, 0] });
  });
});

describe("POST /customer/review", () => {
  const post = (body: object, token = TOKEN) => host(request(app).post("/api/v1/customer/review")).set("X-Order-Token", token).send(body);

  it("a verified buyer's review is live at once: one per order, with the rating totals in the same transaction", async () => {
    const r = await post({ orderId: ORDER, rating: 5, comment: "  Lovely\n\n\n\nhoops " });
    expect(r.status).toBe(201);
    expect(r.body.review).toMatchObject({ rating: 5, comment: "Lovely\n\nhoops", authorName: "Ann L.", items: ["Hoop earrings", "Ring"], reply: null });
    expect(r.body.review.email).toBeUndefined();
    const tx = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(tx[0].Put!.Item!.sk).toBe(`REVIEW_FOR#${ORDER}`);
    expect(tx[0].Put!.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(tx[1].Put!.Item).toMatchObject({ status: "PUBLISHED", rating: 5 });
    expect(JSON.stringify(tx[1].Put!.Item)).not.toContain("ann@example.com");
    expect(tx[2].Update!.ExpressionAttributeValues).toEqual({ ":n": 1, ":s": 5 });
    expect(tx[2].Update!.ExpressionAttributeNames!["#r"]).toBe("r5");
  });

  it("a second review for the order is 409 REVIEW_EXISTS", async () => {
    ddb.on(TransactWriteCommand).rejects(Object.assign(new Error("x"), { name: "TransactionCanceledException" }));
    const r = await post({ orderId: ORDER, rating: 4 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("REVIEW_EXISTS");
  });

  it("a wrong token is an unknown order; not-yet and refunded orders are refused", async () => {
    expect((await post({ orderId: ORDER, rating: 4 }, "nope")).status).toBe(404);
    vi.mocked(getOrderById).mockResolvedValueOnce(order({ storeOrderStatus: "PAID" }));
    expect((await post({ orderId: ORDER, rating: 4 })).body.code).toBe("NOT_YET");
    vi.mocked(getOrderById).mockResolvedValueOnce(order({ storeOrderStatus: "REFUNDED" }));
    expect((await post({ orderId: ORDER, rating: 4 })).body.code).toBe("NOT_REVIEWABLE");
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("400 for a rating that isn't 1–5 or a comment that's too long", async () => {
    for (const rating of [0, 6, 4.5, "5"]) expect((await post({ orderId: ORDER, rating })).status).toBe(400);
    expect((await post({ orderId: ORDER, rating: 5, comment: "x".repeat(2001) })).body.code).toBe("COMMENT_TOO_LONG");
  });
});

describe("GET /customer/review/:orderId", () => {
  const get = (token = TOKEN) => host(request(app).get(`/api/v1/customer/review/${ORDER}`)).set("X-Order-Token", token);

  it("says whether the order can be reviewed, or shows the review (and if an admin removed it)", async () => {
    ddb.on(GetCommand).resolves({});
    expect((await get()).body).toEqual({ state: "OK", removed: false, review: null });
    ddb.reset();
    ddb.on(GetCommand, { Key: { pk: `STORE#${STORE}`, sk: `REVIEW_FOR#${ORDER}` } }).resolves({ Item: { reviewSk: SK } });
    ddb.on(GetCommand, { Key: { pk: `STORE#${STORE}`, sk: SK } }).resolves({ Item: review({ status: "REMOVED" }) });
    const r = await get();
    expect(r.body).toMatchObject({ state: "REVIEWED", removed: true, review: { rating: 2, comment: "Late" } });
    expect((await get("bad")).status).toBe(404);
  });
});

describe("GET /store/public/reviews/:storeId", () => {
  it("published only, newest first, rating summary on the first page; no order ids or reports", async () => {
    ddb.on(QueryCommand).resolves({ Items: [review({ report: { reason: "SPAM", status: "KEPT" }, reply: { text: "Sorry!", at: 2 } })] });
    ddb.on(GetCommand).resolves({ Item: { count: 1, sum: 2, r2: 1 } });
    const r = await host(request(app).get(`/api/v1/store/public/reviews/${STORE}`));
    expect(r.status).toBe(200);
    expect(r.body.stats).toEqual({ count: 1, average: 2, distribution: [0, 1, 0, 0, 0] });
    expect(r.body.reviews[0]).toEqual({ rating: 2, comment: "Late", authorName: "Ann L.", items: ["Ring"], createdAt: 1_700_000_000_000, reply: { text: "Sorry!", at: 2 } });
    const q = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(q.FilterExpression).toBe("#st = :pub");
    expect(q.ScanIndexForward).toBe(false);
    const next = await host(request(app).get(`/api/v1/store/public/reviews/${STORE}?cursor=${encodeURIComponent(SK)}`));
    expect(next.body.stats).toBeNull();
    expect((await host(request(app).get(`/api/v1/store/public/reviews/${STORE}?cursor=junk`))).status).toBe(400);
  });
});

describe("merchant: reply and report, never edit or remove", () => {
  const auth = (r: request.Test) => host(r).set("Authorization", "Bearer t");
  const found = (over: Record<string, unknown> = {}) => {
    ddb.on(GetCommand, { Key: { pk: `STORE#${STORE}`, sk: `REVIEW_FOR#${ORDER}` } }).resolves({ Item: { reviewSk: SK } });
    ddb.on(GetCommand, { Key: { pk: `STORE#${STORE}`, sk: SK } }).resolves({ Item: review(over) });
  };

  it("reply: set, replace, or remove with an empty text; only on a published review", async () => {
    found();
    const r = await auth(request(app).put("/api/v1/store/reviews/reply")).send({ storeId: STORE, orderId: ORDER, text: " Thanks for telling us " });
    expect(r.status).toBe(200);
    expect(r.body.reply.text).toBe("Thanks for telling us");
    const u = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(u.UpdateExpression).toBe("SET #reply = :r");
    expect(u.ConditionExpression).toBe("attribute_exists(pk) AND #st = :pub");
    const del = await auth(request(app).put("/api/v1/store/reviews/reply")).send({ storeId: STORE, orderId: ORDER, text: "" });
    expect(del.body.reply).toBeNull();
    expect(ddb.commandCalls(UpdateCommand)[1].args[0].input.UpdateExpression).toBe("REMOVE #reply");
    ddb.on(UpdateCommand).rejects(Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }));
    expect((await auth(request(app).put("/api/v1/store/reviews/reply")).send({ storeId: STORE, orderId: ORDER, text: "x" })).status).toBe(404);
  });

  it("report: queued for the platform, the review stays live, the admin is emailed; once only", async () => {
    found();
    const r = await auth(request(app).post("/api/v1/store/reviews/report")).send({ storeId: STORE, orderId: ORDER, reason: "OFFENSIVE", note: "Slurs" });
    expect(r.status).toBe(200);
    const tx = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(tx[0].Update!.ConditionExpression).toContain("attribute_not_exists(#report)");
    expect(tx[0].Update!.ExpressionAttributeValues![":r"]).toMatchObject({ reason: "OFFENSIVE", status: "OPEN", byUserId: "USER1" });
    expect(tx[1].Put!.Item).toMatchObject({ pk: "APP_REVIEW_REPORT", sk: `STORE#${STORE}#REVIEW#${ORDER}`, storeName: "Northern Hoop", reason: "OFFENSIVE" });
    expect(JSON.stringify(tx)).not.toContain("REMOVED");
    expect(notifyReviewReported).toHaveBeenCalledWith(STORE, "Northern Hoop", 2, "OFFENSIVE");
    ddb.reset();
    found({ report: { reason: "SPAM", status: "KEPT" } });
    expect((await auth(request(app).post("/api/v1/store/reviews/report")).send({ storeId: STORE, orderId: ORDER, reason: "SPAM" })).body.code).toBe("ALREADY_REPORTED");
  });

  it("OTHER needs a note; an unknown reason is 400", async () => {
    found();
    expect((await auth(request(app).post("/api/v1/store/reviews/report")).send({ storeId: STORE, orderId: ORDER, reason: "OTHER" })).body.code).toBe("NOTE_REQUIRED");
    expect((await auth(request(app).post("/api/v1/store/reviews/report")).send({ storeId: STORE, orderId: ORDER, reason: "MEAN" })).status).toBe(400);
  });

  it("the merchant's list shows removed reviews and the report's state, not who reported", async () => {
    ddb.on(QueryCommand).resolves({ Items: [review({ status: "REMOVED", report: { reason: "SPAM", note: "", at: 1, byUserId: "USER1", status: "REMOVED" } })] });
    ddb.on(GetCommand).resolves({});
    const r = await auth(request(app).get(`/api/v1/store/reviews/list/${STORE}`));
    expect(r.body.reviews[0]).toMatchObject({ status: "REMOVED", report: { reason: "SPAM", status: "REMOVED" } });
    expect(r.body.reviews[0].report.byUserId).toBeUndefined();
    expect(ddb.commandCalls(QueryCommand)[0].args[0].input.FilterExpression).toBeUndefined();
  });

  it("there is no route to edit or delete a review", async () => {
    for (const [m, p] of [["delete", `/store/reviews/delete/${STORE}/${ORDER}`], ["put", "/store/reviews/update"]] as const) {
      expect((await auth(request(app)[m](`/api/v1${p}`)).send({ storeId: STORE })).status).toBe(404);
    }
  });
});

describe("admin: keep or remove a reported review", () => {
  const admin = (r: request.Test) => host(r).set("Authorization", "Bearer t");
  beforeEach(() => vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "a", "cognito:groups": ["Admins"] } as any));
  const open = () => {
    ddb.on(GetCommand, { Key: { pk: `STORE#${STORE}`, sk: `REVIEW_FOR#${ORDER}` } }).resolves({ Item: { reviewSk: SK } });
    ddb.on(GetCommand, { Key: { pk: `STORE#${STORE}`, sk: SK } }).resolves({ Item: review({ report: { reason: "SPAM", status: "OPEN" } }) });
  };
  const decide = (decision: string) => admin(request(app).post("/api/v1/admin/decide-review-report")).send({ storeId: STORE, orderId: ORDER, decision });

  it("REMOVE hides it and takes it out of the rating; KEEP leaves the stats alone; both clear the queue", async () => {
    open();
    expect((await decide("REMOVE")).status).toBe(200);
    let tx = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(tx[0].Update!.ExpressionAttributeValues![":removed"]).toBe("REMOVED");
    expect(tx[1].Delete!.Key).toEqual({ pk: "APP_REVIEW_REPORT", sk: `STORE#${STORE}#REVIEW#${ORDER}` });
    expect(tx[2].Update!.ExpressionAttributeValues).toEqual({ ":n": -1, ":s": -2 });
    ddb.reset();
    open();
    expect((await decide("KEEP")).status).toBe(200);
    tx = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(tx).toHaveLength(2);
    expect(tx[0].Update!.ExpressionAttributeValues![":kept"]).toBe("KEPT");
  });

  it("409 REPORT_CHANGED when there's no open report; merchants can't call it", async () => {
    ddb.on(GetCommand).resolves({});
    expect((await decide("KEEP")).body.code).toBe("REPORT_CHANGED");
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "m", "cognito:groups": [] } as any);
    expect((await decide("REMOVE")).status).toBe(403);
    expect((await admin(request(app).get("/api/v1/admin/get-review-reports"))).status).toBe(403);
  });

  it("the queue lists open reports, oldest first", async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ pk: "p", sk: "s1", reviewSk: SK, storeId: STORE, reportedAt: 5 }, { pk: "p", sk: "s2", reviewSk: SK, storeId: STORE, reportedAt: 1 }] });
    const r = await admin(request(app).get("/api/v1/admin/get-review-reports"));
    expect(r.body.reports.map((x: { reportedAt: number }) => x.reportedAt)).toEqual([1, 5]);
    expect(r.body.reports[0].reviewSk).toBeUndefined();
  });
});
