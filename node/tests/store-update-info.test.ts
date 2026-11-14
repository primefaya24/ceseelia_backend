import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  findUserIdByCognitoId: vi.fn(),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getMembership: vi.fn(),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { findUserIdByCognitoId } from "../layers/aws/dynamodb/dynamo-entities/user";
import { getMembership } from "../layers/aws/dynamodb/dynamo-entities/membership";
import { updateInfoLimits } from "../api/v1/store/update-info";
import { createApp } from "../app";

const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = "01JBZ0000000000000000000AA";
const OVERVIEW_KEY = { pk: "APP_STORE", sk: `STORE#${STORE}#OVERVIEW` };
const body = { storeId: STORE, storeName: "  New Name ", storeSlug: "new-name" };

const post = (b: object = body) =>
  request(app).post("/api/v1/store/update-info").set("Host", "localhost").set("Authorization", "Bearer t").send(b);
const asUser = () => vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "s", "cognito:groups": [] });
const memberAs = (role: "ADMIN" | "MERCHANT" | null) =>
  vi.mocked(getMembership).mockResolvedValue(role ? { storeId: STORE, userId: "U1", role, createdAt: 1 } : null);
const cancelled = (codes: string[]) =>
  Object.assign(new Error("cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

beforeEach(() => {
  ddb.reset();
  updateInfoLimits.perStore.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(findUserIdByCognitoId).mockReset().mockResolvedValue("U1");
  asUser();
  memberAs("ADMIN");
  ddb.on(GetCommand).callsFake((input) =>
    input.Key.pk === "APP_STORE"
      ? { Item: { ...OVERVIEW_KEY, storeId: STORE, storeName: "Old", storeSlug: "old-name", storeOrderLastCompletedTimestamp: 0 } }
      : { Item: { ...input.Key, storeId: STORE } } // the old slug is ours
  );
});

describe("POST /store/update-info (P.11)", () => {
  it("a store ADMIN renames the store and changes its link; the old link is released", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ storeId: STORE, storeName: "New Name", storeSlug: "new-name" });
    const items = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(items[0].Update!.ExpressionAttributeValues).toMatchObject({ ":storeName": "New Name", ":storeSlug": "new-name" });
    expect(items[2].Update!.ExpressionAttributeValues).toEqual({ ":storeName": "New Name" });
    expect(items[3].Delete!.Key).toEqual({ pk: "SLUG#old-name", sk: "STORE" });
  });

  it("a MERCHANT member can't (403); a non-member can't (403); the platform admin can", async () => {
    memberAs("MERCHANT");
    expect((await post()).status).toBe(403);
    memberAs(null);
    expect((await post()).status).toBe(403);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);

    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "a", "cognito:groups": ["Admins"] });
    ddb.on(TransactWriteCommand).resolves({});
    expect((await post()).status).toBe(200);
  });

  it.each([
    [{ ...body, storeName: "   " }],
    [{ ...body, storeName: "x".repeat(200) }],
    [{ ...body, storeSlug: "Bad Slug" }],
    [{ ...body, storeSlug: "admin" }],
    [{ ...body, storeId: "nope" }],
    [{ storeId: STORE, storeName: "N" }],
  ])("400 for %j", async (b) => {
    expect((await post(b)).status).toBe(400);
  });

  it("409 SLUG_TAKEN; 404 STORE_NOT_FOUND", async () => {
    ddb.on(TransactWriteCommand).rejects(cancelled(["None", "ConditionalCheckFailed", "None", "None"]));
    const taken = await post();
    expect([taken.status, taken.body.code]).toEqual([409, "SLUG_TAKEN"]);

    ddb.on(GetCommand).resolves({});
    const gone = await post();
    expect([gone.status, gone.body.code]).toEqual([404, "STORE_NOT_FOUND"]);
  });

  it("10 saves per store per hour, then 429", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    for (let i = 0; i < 10; i++) expect((await post()).status).toBe(200);
    const res = await post();
    expect([res.status, res.body.code]).toEqual([429, "RATE_LIMITED"]);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });
});
