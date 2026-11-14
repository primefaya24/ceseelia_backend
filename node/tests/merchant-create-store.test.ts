import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  findUserIdByCognitoId: vi.fn(),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { findUserIdByCognitoId, UserDeactivatedError } from "../layers/aws/dynamodb/dynamo-entities/user";
import { createStoreLimits } from "../api/v1/merchant/create-store";
import { createApp } from "../app";

const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const USER = "11111111-2222-3333-4444-555555555555";

const post = (body: object, auth = true) => {
  const r = request(app).post("/api/v1/merchant/create-store").set("Host", "localhost");
  return (auth ? r.set("Authorization", "Bearer t") : r).send(body);
};
const valid = { storeName: "  Northern Hoop  ", storeSlug: "northern-hoop" };
const cancelled = (codes: string[]) =>
  new TransactionCanceledException({
    message: "cancelled",
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
/** The caller already belongs to these stores (their USER#/STORE# rows). */
const belongsTo = (roles: string[]) => {
  ddb.on(QueryCommand).resolves({
    Items: roles.map((storeMemberPermission, i) => {
      const storeId = `01JBZ00000000000000000000${i}`;
      return { pk: `USER#${USER}`, sk: `STORE#${storeId}`, storeId, storeMemberPermission };
    }),
  });
};

beforeEach(() => {
  ddb.reset();
  createStoreLimits.perAccount.reset();
  vi.mocked(verifyCognitoAccessToken).mockReset().mockResolvedValue({ sub: "c1", "cognito:groups": [] });
  vi.mocked(findUserIdByCognitoId).mockReset().mockResolvedValue(USER);
  vi.spyOn(console, "error").mockImplementation(() => {});
  belongsTo([]);
});

describe("POST /merchant/create-store (P.3)", () => {
  it("creates a draft with no plan, with the caller as ADMIN, all in one transaction", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const res = await post(valid);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      storeName: "Northern Hoop",
      storeSlug: "northern-hoop",
      status: "DRAFT",
      plan: "NONE",
    });
    const storeId = res.body.storeId;

    const items = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(items).toHaveLength(6);
    const [overview, settings, slug, profileCheck, member, reverse] = items;
    expect(overview.Put!.Item).toMatchObject({ pk: "APP_STORE", storeId, storeName: "Northern Hoop" });
    expect(settings.Put!.Item).toMatchObject({
      pk: `STORE#${storeId}`,
      sk: "SETTINGS",
      lifecycle: { status: "DRAFT", plan: "NONE", createdByUserId: USER },
      admin: { suspended: false },
    });
    expect(slug.Put!.Item).toMatchObject({ pk: "SLUG#northern-hoop", storeId });
    expect(profileCheck.ConditionCheck).toMatchObject({ Key: { pk: `USER#${USER}`, sk: "PROFILE#INFO" } });
    expect(member.Put!.Item).toMatchObject({ pk: `STORE#${storeId}`, sk: `MEMBER#${USER}`, storeMemberPermission: "ADMIN" });
    expect(reverse.Put!.Item).toMatchObject({ pk: `USER#${USER}`, sk: `STORE#${storeId}`, storeMemberPermission: "ADMIN" });
  });

  it("ignores anything else in the body: no way to pick a status, plan or owner", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const res = await post({ ...valid, status: "LIVE", plan: "NOVA", lifecycle: { status: "LIVE" }, userId: "someone-else" });
    expect(res.status).toBe(200);
    const [, settings, , , member] =
      ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(settings.Put!.Item!.lifecycle).toMatchObject({
      status: "DRAFT",
      plan: "NONE",
      createdByUserId: USER,
    });
    expect(member.Put!.Item!.sk).toBe(`MEMBER#${USER}`);
  });

  it("needs a signed-in user", async () => {
    expect((await post(valid, false)).status).toBe(401);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each([
    [{ storeName: "", storeSlug: "ok-slug" }],
    [{ storeName: "   ", storeSlug: "ok-slug" }],
    [{ storeName: "x".repeat(200), storeSlug: "ok-slug" }],
    [{ storeName: "Hoop", storeSlug: "Bad Slug!" }],
    [{ storeName: "Hoop" }],
    [{ storeName: 5, storeSlug: "ok-slug" }],
  ])("400 for %j", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("an account without user rows: 404 PROFILE_NOT_FOUND; deactivated: 403", async () => {
    vi.mocked(findUserIdByCognitoId).mockResolvedValueOnce(null);
    expect((await post(valid)).body.code).toBe("PROFILE_NOT_FOUND");
    vi.mocked(findUserIdByCognitoId).mockRejectedValueOnce(new UserDeactivatedError());
    const res = await post(valid);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_DEACTIVATED");
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("409 SLUG_TAKEN; 404 PROFILE_NOT_FOUND when the profile row is gone mid-way", async () => {
    ddb
      .on(TransactWriteCommand)
      .rejectsOnce(cancelled(["None", "None", "ConditionalCheckFailed", "None", "None", "None"]))
      .rejectsOnce(cancelled(["None", "None", "None", "ConditionalCheckFailed", "None", "None"]));
    const taken = await post(valid);
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("SLUG_TAKEN");
    const gone = await post(valid);
    expect([gone.status, gone.body.code]).toEqual([404, "PROFILE_NOT_FOUND"]);
  });

  it.each([["ADMIN"], ["MERCHANT"]])(
    "one store per account (P.11): already %s of a store → 409 ALREADY_IN_A_STORE, nothing written",
    async (role) => {
      ddb.on(TransactWriteCommand).resolves({});
      belongsTo([role]);
      const res = await post(valid);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("ALREADY_IN_A_STORE");
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
      expect(ddb.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues).toMatchObject({
        ":pk": `USER#${USER}`,
        ":sk_prefix": "STORE#",
      });
    }
  );

  it("5 creates per account per hour, then 429 with Retry-After", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    for (let i = 0; i < 5; i++) expect((await post(valid)).status).toBe(200);
    const res = await post(valid);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });
});
