import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  getUserContact: vi.fn(async (sub: string) => ({ userId: `USER-${sub}`, email: `${sub}@example.com`, name: "Ann Lee" })),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getMembership: vi.fn(async () => ({ role: "MERCHANT" })),
  getStoreOverviewRow: vi.fn(async () => ({ storeName: "Northern Hoop" })),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/support-ticket", async (orig) => {
  const real = await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/support-ticket")>();
  return {
    ...real,
    createTicket: vi.fn(async (i: any) => ({ ...i, ticketId: "01JBZ0000000000000000000TK", status: "OPEN", messageCount: 1, lastFrom: "USER", preview: i.body, createdAt: i.now, updatedAt: i.now, closedAt: null })),
    getTicket: vi.fn(),
    listUserTickets: vi.fn(async () => []),
    listTicketMessages: vi.fn(async () => []),
    addTicketMessage: vi.fn(async (t: any, from: string) => ({ ...t, status: from === "USER" ? "OPEN" : "ANSWERED" })),
    closeTicket: vi.fn(async () => true),
  };
});
vi.mock("../layers/notifications/admin-alerts", async (orig) => ({
  ...(await orig<typeof import("../layers/notifications/admin-alerts")>()),
  notifyTicket: vi.fn(async () => {}),
}));
vi.mock("../layers/notifications/support-emails", () => ({ notifyTicketAnswered: vi.fn(async () => {}) }));

import { createApp } from "../app";
import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { computeAdminOverview, mapLimit, AdminStatsOrder, AdminStoreInput } from "../layers/core/admin-stats";
import { commissionCsv, commissionRow, isReportMonth, monthRange, reconcileRow, sumStripeFees } from "../layers/core/commission";
import { MAX_MESSAGES, SupportTicket } from "../layers/aws/dynamodb/dynamo-entities/support-ticket";
import * as tickets from "../layers/aws/dynamodb/dynamo-entities/support-ticket";
import { getMembership } from "../layers/aws/dynamodb/dynamo-entities/membership";
import { notifyTicket } from "../layers/notifications/admin-alerts";
import { notifyTicketAnswered } from "../layers/notifications/support-emails";
import { resetSupportLimitsForTests } from "../api/v1/user/support";

const DAY = 24 * 3600_000;
const NOW = Date.UTC(2026, 10, 15, 18, 0, 0); // 15 Nov 2026, 18:00 UTC
const order = (paidAt: number | undefined, over: Partial<AdminStatsOrder> = {}): AdminStatsOrder => ({
  storeOrderStatus: "COMPLETED",
  storeOrderPaidAt: paidAt,
  storeOrderTotalMinor: 5000,
  storeOrderRefundedMinor: 0,
  storeOrderCurrency: "CAD",
  storeOrderPlatformFeeMinor: 125,
  ...over,
});
const store = (id: string, orders: AdminStatsOrder[], over: Partial<AdminStoreInput> = {}): AdminStoreInput => ({
  storeId: id,
  storeName: `Store ${id}`,
  status: "LIVE",
  suspended: false,
  plan: "SPARK",
  subscriptionStatus: "active",
  orders,
  ...over,
});
const extra = { merchants: 3, queues: { storeReviews: 1, itemReviews: 0, reviewReports: 2, openTickets: 4 }, partial: false };

describe("admin overview numbers (L.8 / 8.1)", () => {
  it("counts paid orders, net sales and commission for the last 30 days vs the 30 before", () => {
    const stats = computeAdminOverview(
      [
        store("A", [
          order(NOW - 1000),
          order(NOW - 2 * DAY, { storeOrderRefundedMinor: 1000 }),
          // fully refunded: not an order, no sales, but the fee was kept
          order(NOW - 3 * DAY, { storeOrderStatus: "REFUNDED", storeOrderRefundedMinor: 5000 }),
          order(NOW - 40 * DAY),
          order(undefined, { storeOrderStatus: "PENDING_PAYMENT" }),
          order(NOW - DAY, { storeOrderStatus: "CANCELLED" }),
          order(NOW - DAY, { storeOrderCurrency: "USD", storeOrderTotalMinor: 2000, storeOrderPlatformFeeMinor: 145 }),
        ]),
        store("B", [], { status: "DRAFT", plan: "NONE", subscriptionStatus: null }),
        store("C", [], { status: "IN_REVIEW", suspended: true, plan: "NOVA", subscriptionStatus: "past_due" }),
      ],
      extra,
      NOW,
      "UTC"
    );
    expect(stats.stores).toEqual({ total: 3, live: 1, draft: 1, inReview: 1, suspended: 1 });
    expect(stats.plans).toEqual({ SPARK: 1, NOVA: 1 });
    expect(stats.subscriptionsPastDue).toBe(1);
    expect(stats.merchants).toBe(3);
    expect(stats.last30.orders).toBe(3);
    expect(stats.last30.sales).toEqual([{ currency: "CAD", minor: 9000 }, { currency: "USD", minor: 2000 }]);
    expect(stats.last30.commission).toEqual([{ currency: "CAD", minor: 375 }, { currency: "USD", minor: 145 }]);
    expect(stats.previous30).toMatchObject({ orders: 1, sales: [{ currency: "CAD", minor: 5000 }] });
    expect(stats.days).toHaveLength(30);
    expect(stats.days.at(-1)).toMatchObject({ date: "2026-11-15", orders: 1 });
    expect(stats.topStores).toEqual([{ storeId: "A", storeName: "Store A", orders: 3, sales: stats.last30.sales }]);
    expect(stats.queues.openTickets).toBe(4);
  });

  it("days are the admin's: 23:30 UTC on the 14th is the 15th in Halifax... and the 14th in UTC", () => {
    const paid = Date.UTC(2026, 10, 14, 23, 30);
    const utc = computeAdminOverview([store("A", [order(paid)])], extra, NOW, "UTC");
    const hfx = computeAdminOverview([store("A", [order(paid)])], extra, NOW, "America/Halifax");
    expect(utc.days.find((d) => d.orders)?.date).toBe("2026-11-14");
    expect(hfx.days.find((d) => d.orders)?.date).toBe("2026-11-14");
    const tokyo = computeAdminOverview([store("A", [order(paid)])], extra, NOW, "Asia/Tokyo");
    expect(tokyo.days.find((d) => d.orders)?.date).toBe("2026-11-15");
  });

  it("mapLimit keeps order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});

describe("commission report (L.8 / 8.4)", () => {
  it("months: real ones only, in the admin's time zone", () => {
    expect(isReportMonth("2026-11", NOW)).toBe(true);
    expect(isReportMonth("2026-13", NOW)).toBe(false);
    expect(isReportMonth("2027-01", NOW)).toBe(false);
    expect(isReportMonth("2023-12", NOW)).toBe(false);
    expect(isReportMonth("2026-1", NOW)).toBe(false);
    const { start, end } = monthRange("2026-11", "America/Toronto");
    expect(new Date(start).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-12-01T05:00:00.000Z");
  });

  it("one store's month: sales before refunds, refunds, the fee kept on refunds; outside the month left out", () => {
    const { start, end } = monthRange("2026-11", "UTC");
    const row = commissionRow({ storeId: "A", storeName: "Hoop", plan: "SPARK" }, [
      order(start + 1000),
      order(start + DAY, { storeOrderStatus: "REFUNDED", storeOrderRefundedMinor: 5000 }),
      order(start - 1000),
      order(end),
      order(undefined, { storeOrderStatus: "PENDING_PAYMENT" }),
    ], start, end);
    expect(row).toMatchObject({
      orders: 2,
      sales: [{ currency: "CAD", minor: 10000 }],
      refunds: [{ currency: "CAD", minor: 5000 }],
      commission: [{ currency: "CAD", minor: 250 }],
    });
  });

  it("reconciles against Stripe's fees, by account and currency", () => {
    const { start, end } = monthRange("2026-11", "UTC");
    const row = commissionRow({ storeId: "A", storeName: "Hoop", plan: "SPARK" }, [order(start + 1), order(start + 2)], start, end);
    const fees = sumStripeFees([
      { account: "acct_A", currency: "cad", amount: 125, amountRefunded: 0 },
      { account: "acct_A", currency: "cad", amount: 125, amountRefunded: 0 },
      { account: "acct_X", currency: "usd", amount: 99, amountRefunded: 0 },
    ]);
    expect(reconcileRow(row, fees.get("acct_A"), 2).matches).toBe(true);
    expect(reconcileRow(row, fees.get("acct_A"), 3).matches).toBe(false);
    expect(reconcileRow(row, undefined, 2)).toMatchObject({ matches: false, stripe: { count: 0 } });
    expect(fees.get("acct_X")).toEqual({ count: 1, fees: [{ currency: "USD", minor: 99 }], refunded: [] });
  });

  it("CSV: a row per store and currency; a store name can't run as a formula", () => {
    const { start, end } = monthRange("2026-11", "UTC");
    const row = commissionRow({ storeId: "A", storeName: '=HYPERLINK("x")', plan: "SPARK" }, [order(start + 1)], start, end);
    const csv = commissionCsv("2026-11", [row]);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`2026-11,"'=HYPERLINK(""x"")",A,SPARK,CAD,1,50.00,0.00,1.25`);
  });
});

/* ---------------- Support tickets (L.8 / 8.3) ---------------- */

const app = createApp();
const TICKET = "01JBZ0000000000000000000TK";
const STORE = "01JBZ0000000000000000000AA";
const as = (sub: string, admin = false) =>
  vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub, "cognito:groups": admin ? ["Admins"] : [] });
const call = (method: "get" | "post", path: string, body?: object) => {
  const r = request(app)[method](`/api/v1${path}`).set("Host", "localhost").set("Authorization", "Bearer t");
  return body ? r.send(body) : r;
};
const ticket = (over: Partial<SupportTicket> = {}): SupportTicket => ({
  ticketId: TICKET,
  userId: "USER-ann",
  userEmail: "ann@example.com",
  userName: "Ann Lee",
  storeId: null,
  storeName: null,
  subject: "Payouts",
  category: "ORDERS_PAYMENTS",
  status: "OPEN",
  messageCount: 1,
  lastFrom: "USER",
  preview: "Hi",
  createdAt: 1,
  updatedAt: 1,
  closedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetSupportLimitsForTests();
  vi.mocked(tickets.getTicket).mockResolvedValue(ticket());
  vi.mocked(tickets.listUserTickets).mockResolvedValue([]);
});

describe("user support routes", () => {
  it("opens a ticket (text cleaned, for a store of theirs) and tells the team", async () => {
    as("ann");
    const res = await call("post", "/user/support/tickets", { subject: "  Payouts \n late ", category: "ORDERS_PAYMENTS", message: "Hi\u0000 there", storeId: STORE });
    expect(res.status).toBe(200);
    expect(tickets.createTicket).toHaveBeenCalledWith(expect.objectContaining({ userId: "USER-ann", subject: "Payouts late", body: "Hi there", storeName: "Northern Hoop" }));
    expect(res.body.ticket).not.toHaveProperty("userEmail");
    expect(notifyTicket).toHaveBeenCalledWith(expect.objectContaining({ subject: "Payouts late" }), "NEW");
  });

  it("refuses a store they're not in, a bad category, an empty or long message", async () => {
    as("ann");
    vi.mocked(getMembership).mockResolvedValueOnce(null);
    expect((await call("post", "/user/support/tickets", { subject: "x", category: "OTHER", message: "y", storeId: STORE })).body.code).toBe("STORE_NOT_YOURS");
    expect((await call("post", "/user/support/tickets", { subject: "x", category: "NOPE", message: "y" })).status).toBe(400);
    expect((await call("post", "/user/support/tickets", { subject: "x", category: "OTHER", message: "  " })).status).toBe(400);
    expect((await call("post", "/user/support/tickets", { subject: "x", category: "OTHER", message: "y".repeat(4001) })).status).toBe(400);
    expect((await call("post", "/user/support/tickets", { subject: "x".repeat(121), category: "OTHER", message: "y" })).status).toBe(400);
  });

  it("5 new tickets a day, and at most 10 open", async () => {
    as("ann");
    const body = { subject: "x", category: "OTHER", message: "y" };
    for (let i = 0; i < 5; i++) expect((await call("post", "/user/support/tickets", body)).status).toBe(200);
    expect((await call("post", "/user/support/tickets", body)).status).toBe(429);
    vi.mocked(tickets.listUserTickets).mockResolvedValue(Array.from({ length: 10 }, () => ticket()));
    expect((await call("post", "/user/support/tickets", body)).body.code).toBe("TOO_MANY_OPEN");
  });

  it("someone else's ticket is a 404 to read, reply to or close", async () => {
    as("bob");
    expect((await call("get", `/user/support/tickets/${TICKET}`)).status).toBe(404);
    expect((await call("post", `/user/support/tickets/${TICKET}/reply`, { message: "hi" })).status).toBe(404);
    expect((await call("post", `/user/support/tickets/${TICKET}/close`)).status).toBe(404);
    expect(tickets.addTicketMessage).not.toHaveBeenCalled();
    expect(tickets.closeTicket).not.toHaveBeenCalled();
  });

  it("the owner replies (team told) and closes", async () => {
    as("ann");
    expect((await call("post", `/user/support/tickets/${TICKET}/reply`, { message: "More info" })).status).toBe(200);
    expect(tickets.addTicketMessage).toHaveBeenCalledWith(expect.objectContaining({ ticketId: TICKET }), "USER", "Ann Lee", "More info", expect.any(Number));
    expect(notifyTicket).toHaveBeenCalledWith(expect.anything(), "REPLY");
    expect((await call("post", `/user/support/tickets/${TICKET}/close`)).status).toBe(200);
  });
});

describe("admin support routes", () => {
  it("admins only", async () => {
    as("ann");
    expect((await call("get", "/admin/support/tickets")).status).toBe(403);
    expect((await call("post", `/admin/support/tickets/${TICKET}/reply`, { message: "x" })).status).toBe(403);
    expect((await call("get", "/admin/commission-report?month=2026-11")).status).toBe(403);
    expect((await call("get", "/admin/get-overview-data")).status).toBe(403);
  });

  it("a reply is signed by Ceseelia support and emails the user a link", async () => {
    as("root", true);
    const res = await call("post", `/admin/support/tickets/${TICKET}/reply`, { message: "Payouts go out on Fridays." });
    expect(res.status).toBe(200);
    expect(tickets.addTicketMessage).toHaveBeenCalledWith(expect.anything(), "ADMIN", "Ceseelia support", "Payouts go out on Fridays.", expect.any(Number));
    expect(notifyTicketAnswered).toHaveBeenCalledWith("ann@example.com", expect.objectContaining({ ticketId: TICKET }));
  });

  it("bad month or time zone → 400", async () => {
    as("root", true);
    expect((await call("get", "/admin/commission-report?month=2026-13")).status).toBe(400);
    expect((await call("get", "/admin/commission-report?month=2026-11&tz=Mars/Base")).status).toBe(400);
    expect((await call("get", "/admin/get-overview-data?tz=nope")).status).toBe(400);
  });
});

describe("ticket messages (entity)", () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => ddb.reset());

  it("a user's reply reopens it; an admin's answers it; both in one write capped at MAX_MESSAGES", async () => {
    const real = await vi.importActual<typeof import("../layers/aws/dynamodb/dynamo-entities/support-ticket")>("../layers/aws/dynamodb/dynamo-entities/support-ticket");
    const realAdd = real.addTicketMessage;
    ddb.on(TransactWriteCommand).resolves({});
    const t = await realAdd(ticket({ status: "CLOSED", closedAt: 5 }), "USER", "Ann", "back again", 10);
    expect(t).toMatchObject({ status: "OPEN", closedAt: null, messageCount: 2 });
    const items = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(items[0].Update!.ConditionExpression).toContain("messageCount < :max");
    expect(items[0].Update!.ExpressionAttributeValues![":max"]).toBe(MAX_MESSAGES);
    expect((await realAdd(ticket(), "ADMIN", "Ceseelia support", "ok", 11)).status).toBe("ANSWERED");
    ddb.on(TransactWriteCommand).rejects(Object.assign(new Error("x"), { name: "TransactionCanceledException" }));
    await expect(realAdd(ticket(), "USER", "Ann", "more", 12)).rejects.toBeInstanceOf(real.TicketFullError);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
