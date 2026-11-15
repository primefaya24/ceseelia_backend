import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { liveStoreSettings } from "./fixtures";

vi.mock("../layers/notifications/order-emails", async (orig) => ({
  ...(await orig<typeof import("../layers/notifications/order-emails")>()),
  sendRewardsCode: vi.fn(async () => {}),
}));

import { createApp } from "../app";
import { StoreOrder, commissionBaseMinor } from "../layers/core/interfaces/store";
import { allocate, maskEmail, normalizeRedemptionMethod, pointsFor, rewardsProgram } from "../layers/core/rewards";
import {
  CODE_MAX_ATTEMPTS,
  checkCode,
  issueCode,
  recordRewardsForOrder,
} from "../layers/aws/dynamodb/dynamo-entities/rewards";
import { customerIdFor } from "../layers/aws/dynamodb/dynamo-entities/customer";
import { cancelPendingOrder, returnRewardsSpend } from "../layers/aws/dynamodb/dynamo-entities/order";
import { sendRewardsCode } from "../layers/notifications/order-emails";
import { resetRewardsLimitsForTests } from "../api/v1/customer/rewards/index";

/*
 * A small in-memory table that applies the conditions the rewards code relies on, so these
 * tests check what DynamoDB would do (one guess counted per request, balance never spent twice),
 * not just which commands were sent.
 */
const ddb = mockClient(DynamoDBDocumentClient);
const rows = new Map<string, Record<string, any>>();
const k = (key: { pk: string; sk: string }) => `${key.pk}|${key.sk}`;
const condFail = () => Object.assign(new Error("cond"), { name: "ConditionalCheckFailedException" });
let now = 1_800_000_000_000;

function applyUpdate(input: any, dryRun = false): void {
  const key = k(input.Key);
  const row = { ...(rows.get(key) ?? {}) } as Record<string, any>;
  const v = input.ExpressionAttributeValues ?? {};
  const n = input.ExpressionAttributeNames ?? {};
  const name = (t: string) => n[t] ?? t;
  const exists = rows.has(key);
  const c: string = input.ConditionExpression ?? "";
  // The conditions in use, by shape.
  if (c.includes("attempts < :max")) {
    if (!exists || !(row.attempts < v[":max"]) || !(row.expiresAt > v[":now"])) throw condFail();
  } else if (c.includes("balance >= :points")) {
    if (!((row.balance ?? Number.NEGATIVE_INFINITY) >= v[":points"])) throw condFail();
  } else if (c.includes("#c < :max")) {
    if (exists && !(row.count < v[":max"])) throw condFail();
  } else if (c.includes("points = :before")) {
    if (row.points !== v[":before"]) throw condFail();
  } else if (c.includes("#st = :pending")) {
    if (row.storeOrderStatus !== "PENDING_PAYMENT") throw condFail();
  } else if (c.includes("#rw.#ret = :false")) {
    if (row.storeOrderRewards?.returned !== false) throw condFail();
  } else if (c) throw new Error(`untested condition ${c}`);
  if (dryRun) return;
  const expr: string = input.UpdateExpression;
  const add = /ADD (.+?)(?= SET|$)/.exec(expr)?.[1];
  const set = /SET (.+?)(?= ADD|$)/.exec(expr)?.[1];
  for (const part of (add ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const [a, b] = part.split(" ");
    row[name(a)] = (row[name(a)] ?? 0) + v[b];
  }
  for (const part of (set ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const [lhs, rhs] = part.split(" = ");
    const path = lhs.split(".").map(name);
    if (path.length === 2) row[path[0]] = { ...(row[path[0]] ?? {}), [path[1]]: v[rhs] };
    else row[path[0]] = v[rhs];
  }
  rows.set(key, { ...input.Key, ...row });
}

function applyPut(input: any, dryRun = false): void {
  if (input.ConditionExpression === "attribute_not_exists(pk)" && rows.has(k(input.Item))) throw condFail();
  if (!dryRun) rows.set(k(input.Item), { ...input.Item });
}

function installTable() {
  rows.clear();
  ddb.reset();
  ddb.on(GetCommand).callsFake((input) => ({ Item: rows.get(k(input.Key)) }));
  ddb.on(PutCommand).callsFake((input) => (applyPut(input), {}));
  ddb.on(UpdateCommand).callsFake((input) => {
    applyUpdate(input);
    return { Attributes: rows.get(k(input.Key)) };
  });
  ddb.on(DeleteCommand).callsFake((input) => {
    const row = rows.get(k(input.Key));
    if (input.ConditionExpression && (!row || row.hash !== input.ExpressionAttributeValues[":h"])) throw condFail();
    rows.delete(k(input.Key));
    return {};
  });
  ddb.on(TransactWriteCommand).callsFake((input) => {
    const items = input.TransactItems as any[];
    const reasons = items.map((t) => {
      try {
        if (t.Put) applyPut(t.Put, true);
        if (t.Update) applyUpdate(t.Update, true);
        return { Code: "None" };
      } catch {
        return { Code: "ConditionalCheckFailed" };
      }
    });
    if (reasons.some((r) => r.Code !== "None"))
      throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException", CancellationReasons: reasons });
    for (const t of items) {
      if (t.Put) applyPut(t.Put);
      if (t.Update) applyUpdate(t.Update);
    }
    return {};
  });
}

const STORE = "01JBZ0000000000000000000AA";
const EMAIL = "ann@example.com";
const CID = customerIdFor(EMAIL);
const PK = `STORE#${STORE}`;
const rewardsOn = (over: object = {}) => ({
  redemptionMethod: "POINTS_TO_MONEY",
  rewardsLabel: "Hoop points",
  redemptionPointAmount: 100,
  redemptionPointAmountValue: 5,
  pointsPerDollarSpent: 2,
  isAvailable: true,
  ...over,
});
function storeWithRewards(over: object = {}) {
  const s = liveStoreSettings();
  rows.set(`${PK}|SETTINGS`, {
    pk: PK,
    sk: "SETTINGS",
    ...s,
    storeInfo: { ...s.storeInfo, storeName: "Northern Hoop" },
    purchaseRewards: rewardsOn(over),
  });
}
const balanceOf = () => rows.get(`${PK}|REWARDS#${CID}`)?.balance;

const app = createApp();
const post = (path: string, body: object, ip = "203.0.113.7", token?: string) => {
  const r = request(app).post(`/api/v1/customer/rewards/${path}`).set("Host", "localhost").set("X-Forwarded-For", ip);
  return (token ? r.set("X-Rewards-Token", token) : r).send(body);
};

beforeEach(() => {
  installTable();
  resetRewardsLimitsForTests();
  vi.mocked(sendRewardsCode).mockClear();
  now += 24 * 3600_000; // a fresh day for the per-email windows
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

describe("rewards rules (L.7 / 7.3)", () => {
  it("reads both spellings of the method, and only runs a filled-in program", () => {
    expect(normalizeRedemptionMethod("REWARDS_REDEMPTION_DOLLAR")).toBe("POINTS_TO_MONEY");
    expect(normalizeRedemptionMethod("REWARDS_REDEMPTION_DISCOUNT")).toBe("POINTS_TO_DISCOUNT");
    expect(rewardsProgram({ purchaseRewards: rewardsOn() as any })).toMatchObject({ kind: "MONEY", value: 500, cost: 100 });
    expect(rewardsProgram({ purchaseRewards: rewardsOn({ redemptionMethod: "REWARDS_REDEMPTION_DISCOUNT", redemptionPointAmountValue: 10 }) as any })).toMatchObject({ kind: "PERCENT", value: 10 });
    expect(rewardsProgram({ purchaseRewards: rewardsOn({ isAvailable: false }) as any })).toBeNull();
    expect(rewardsProgram({ purchaseRewards: rewardsOn({ redemptionPointAmount: 0 }) as any })).toBeNull();
    expect(rewardsProgram({ purchaseRewards: rewardsOn({ pointsPerDollarSpent: 0 }) as any })).toBeNull();
    expect(rewardsProgram({ purchaseRewards: rewardsOn({ redemptionMethod: "POINTS_TO_DISCOUNT", redemptionPointAmountValue: 150 }) as any })).toBeNull();
  });

  it("points round down per whole unit; allocate adds up exactly; emails are masked", () => {
    expect(pointsFor(1001, 1.5)).toBe(15);
    expect(pointsFor(999, 1)).toBe(9);
    expect(pointsFor(-5, 2)).toBe(0);
    const parts = allocate(500, [333, 333, 334]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(500);
    expect(allocate(1000, [100, 200])).toEqual([100, 200]); // never more than a line
    expect(maskEmail("ann@example.com")).toBe("an*@example.com");
  });

  it("commission is on the price after the rewards discount (owner 2026-11-15)", () => {
    const q = { currency: "CAD", subtotalMinor: 10_000, discountMinor: 1000, rewardsMinor: 500, pricesIncludeTax: false, taxPercent: 5, totalMinor: 9000 };
    expect(commissionBaseMinor(q)).toBe(8500);
  });
});

describe("6-digit codes can't be brute-forced", () => {
  const codeRow = () => rows.get(`${PK}|REWARDS_CODE#${CID}`);

  it("is kept hashed and salted, never in the clear", async () => {
    const code = await issueCode(STORE, CID, now);
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(codeRow())).not.toContain(code);
  });

  it("only 5 guesses per code: after them even the right code fails", async () => {
    const code = await issueCode(STORE, CID, now);
    const wrong = (i: number) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, "0");
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) expect(await checkCode(STORE, CID, wrong(i), now)).toBe("WRONG");
    expect(await checkCode(STORE, CID, code, now)).toBe("NO_CODE");
  });

  it("parallel guesses can't get past the count (each is counted before it's compared)", async () => {
    const code = await issueCode(STORE, CID, now);
    const guesses = Array.from({ length: 200 }, (_, i) => String(i).padStart(6, "0"));
    if (!guesses.includes(code)) guesses.push(code);
    const results = await Promise.all(guesses.map((g) => checkCode(STORE, CID, g, now)));
    expect(results.filter((r) => r !== "NO_CODE").length).toBe(CODE_MAX_ATTEMPTS);
  });

  it("works once, and not after 10 minutes", async () => {
    let code = await issueCode(STORE, CID, now);
    expect(await checkCode(STORE, CID, code, now)).toBe("OK");
    expect(await checkCode(STORE, CID, code, now)).toBe("NO_CODE");
    code = await issueCode(STORE, CID, now);
    expect(await checkCode(STORE, CID, code, now + 10 * 60_000 + 1)).toBe("NO_CODE");
  });

  it("anything but 6 digits is wrong without touching the table", async () => {
    await issueCode(STORE, CID, now);
    for (const g of ["12345", "1234567", "12a456", " 123456"]) expect(await checkCode(STORE, CID, g, now)).toBe("WRONG");
    expect(codeRow()!.attempts).toBe(0);
  });
});

describe("request-code and verify routes", () => {
  beforeEach(() => storeWithRewards());

  it("answers the same whether or not the email has points; only an account gets the email", async () => {
    const a = await post("request-code", { storeId: STORE, email: "stranger@example.com" });
    rows.set(`${PK}|REWARDS#${CID}`, { pk: PK, sk: `REWARDS#${CID}`, email: EMAIL, balance: 250 });
    const b = await post("request-code", { storeId: STORE, email: "Ann@Example.com " }, "198.51.100.9");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(sendRewardsCode).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendRewardsCode).mock.calls[0][0]).toBe(EMAIL);
  });

  it("3 codes per email per 15 minutes, from any IP; then 429 (kept in the table)", async () => {
    for (let i = 0; i < 3; i++) expect((await post("request-code", { storeId: STORE, email: EMAIL }, `10.0.0.${i}`)).status).toBe(200);
    const res = await post("request-code", { storeId: STORE, email: EMAIL }, "10.0.0.99");
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("5 code requests per IP per 10 minutes, whatever the email", async () => {
    for (let i = 0; i < 5; i++) expect((await post("request-code", { storeId: STORE, email: `p${i}@example.com` })).status).toBe(200);
    expect((await post("request-code", { storeId: STORE, email: "p9@example.com" })).status).toBe(429);
  });

  it("20 guesses per IP per 10 minutes, across emails", async () => {
    for (let i = 0; i < 20; i++) expect((await post("verify", { storeId: STORE, email: `p${i}@example.com`, code: "000000" })).status).toBe(400);
    expect((await post("verify", { storeId: STORE, email: "p99@example.com", code: "000000" })).status).toBe(429);
  });

  it("the right code gives a session for this store; account shows the balance; sign-out ends it", async () => {
    rows.set(`${PK}|REWARDS#${CID}`, { pk: PK, sk: `REWARDS#${CID}`, email: EMAIL, balance: 250 });
    await post("request-code", { storeId: STORE, email: EMAIL });
    const code = vi.mocked(sendRewardsCode).mock.calls[0][2] as string;

    const bad = await post("verify", { storeId: STORE, email: EMAIL, code: code === "000000" ? "000001" : "000000" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("CODE_WRONG");

    const ok = await post("verify", { storeId: STORE, email: EMAIL, code });
    expect(ok.status).toBe(200);
    expect(ok.body.account).toEqual({ email: "an*@example.com", balance: 250 });
    const token = ok.body.token as string;
    expect([...rows.keys()].some((key) => key.includes(token))).toBe(false); // stored hashed

    const acct = await request(app).get(`/api/v1/customer/rewards/account/${STORE}`).set("Host", "localhost").set("X-Rewards-Token", token);
    expect(acct.status).toBe(200);
    expect(acct.body.account.balance).toBe(250);
    expect(acct.body.program).toMatchObject({ cost: 100, kind: "MONEY", value: 500 });

    await post("sign-out", { storeId: STORE }, undefined, token);
    const after = await request(app).get(`/api/v1/customer/rewards/account/${STORE}`).set("Host", "localhost").set("X-Rewards-Token", token);
    expect(after.status).toBe(401);
  });

  it("a store with rewards off says so", async () => {
    storeWithRewards({ isAvailable: false });
    const res = await post("request-code", { storeId: STORE, email: EMAIL });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REWARDS_OFF");
  });

  it("rejects a bad email or store id", async () => {
    expect((await post("request-code", { storeId: STORE, email: "nope" })).status).toBe(400);
    expect((await post("request-code", { storeId: "x", email: EMAIL })).status).toBe(400);
  });
});

describe("earning and giving points back", () => {
  const ORDER = "01JBZ0000000000000000000RD";
  const paid = (over: Partial<StoreOrder> = {}): StoreOrder =>
    ({
      storeOrderId: ORDER,
      storeId: STORE,
      storeOrderCreatedAt: 1_700_000_000_000,
      storeOrderStatus: "PAID",
      storeOrderPaidAt: now,
      storeOrderCurrency: "CAD",
      storeOrderSubtotalMinor: 10_000,
      storeOrderDiscountMinor: 1000,
      storeOrderTotalMinor: 9450,
      storeOrderCustomer: { name: "Ann", email: "Ann@example.com", phone: "" },
      ...over,
    }) as StoreOrder;

  it("once per order; a refund takes back its share; balance follows", async () => {
    expect(await recordRewardsForOrder(paid(), 2, now)).toBe("ADDED");
    expect(balanceOf()).toBe(180); // $90.00 of items × 2
    expect(await recordRewardsForOrder(paid(), 2, now)).toBe("UNCHANGED");
    expect(balanceOf()).toBe(180);
    // half the total refunded → half the points
    expect(await recordRewardsForOrder(paid({ storeOrderRefundedMinor: 4725 }), null, now)).toBe("UPDATED");
    expect(balanceOf()).toBe(90);
    // the rate is the one when it was paid, even if the store changes it later
    expect(rows.get(`${PK}|REWARDS_EARN#${ORDER}`)!.rate).toBe(2);
  });

  it("nothing for unpaid or cancelled orders, or when the store had no program", async () => {
    expect(await recordRewardsForOrder(paid({ storeOrderStatus: "PENDING_PAYMENT", storeOrderPaidAt: undefined }), 2, now)).toBe("SKIPPED");
    expect(await recordRewardsForOrder(paid({ storeOrderStatus: "CANCELLED" }), 2, now)).toBe("SKIPPED");
    expect(await recordRewardsForOrder(paid(), null, now)).toBe("SKIPPED");
    expect(balanceOf()).toBeUndefined();
  });

  it("points spent on an order that's never paid come back with the cancel, exactly once", async () => {
    rows.set(`${PK}|REWARDS#${CID}`, { pk: PK, sk: `REWARDS#${CID}`, balance: 0, redeemed: 100 });
    const order = paid({
      storeOrderStatus: "PENDING_PAYMENT",
      storeOrderPaidAt: undefined,
      storeOrderRewards: { customerId: CID, points: 100, rewardsMinor: 500, kind: "MONEY", value: 500, returned: false },
    });
    const { orderKey } = await import("../layers/aws/dynamodb/dynamo-entities/order");
    const key = orderKey(STORE, order.storeOrderCreatedAt, ORDER);
    rows.set(k(key), { ...key, ...order });
    expect(await cancelPendingOrder(order, "PAYMENT_EXPIRED", now)).toBe(true);
    expect(balanceOf()).toBe(100);
    expect(await cancelPendingOrder(order, "PAYMENT_EXPIRED", now)).toBe(false); // webhook retry / sweeper
    expect(balanceOf()).toBe(100);
    expect(await returnRewardsSpend({ ...order, storeOrderRewards: { ...order.storeOrderRewards!, returned: false } }, now)).toBe(false);
    expect(balanceOf()).toBe(100);
  });
});
