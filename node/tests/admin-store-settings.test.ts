import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  findUserIdByCognitoId: vi.fn(async () => "USER1"),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getMembership: vi.fn(async (storeId: string, userId: string) => ({ storeId, userId, role: "ADMIN", createdAt: 1 })),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";
import { platformFeeMinor } from "../layers/core/interfaces/store";

const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = "01JBZ0000000000000000000AA";
const asAdmin = () => vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "a", "cognito:groups": ["Admins"] });
const asMember = () => vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "m", "cognito:groups": [] });
const put = (body: object) =>
  request(app).put("/api/v1/admin/update-store-admin-settings").set("Host", "localhost").set("Authorization", "Bearer t").send(body);
const getAdmin = () =>
  request(app).get(`/api/v1/admin/get-store-admin-settings/${STORE}`).set("Host", "localhost").set("Authorization", "Bearer t");
const fees = { USD: 250, CAD: 300, AUD: 0 };
const valid = { storeId: STORE, salesCommissions: fees, isStoreLive: false };

beforeEach(() => {
  ddb.reset();
  vi.mocked(verifyCognitoAccessToken).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  asAdmin();
});

describe("PUT /admin/update-store-admin-settings", () => {
  it("saves only commission and store-live on the SETTINGS row", async () => {
    ddb.on(UpdateCommand).resolves({});
    const res = await put({ ...valid, extra: "ignored" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ salesCommissions: fees, isStoreLive: false });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual({ pk: `STORE#${STORE}`, sk: "SETTINGS" });
    expect(input.UpdateExpression).toBe("SET #admin = :admin");
    expect(input.ExpressionAttributeValues).toEqual({ ":admin": { salesCommissions: fees, isStoreLive: false } });
    expect(input.ConditionExpression).toBe("attribute_exists(pk)");
  });

  it("is admin-only, even for the store's own admin member", async () => {
    asMember();
    expect((await put(valid)).status).toBe(403);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it.each([
    [{ ...valid, salesCommissions: { ...fees, USD: -1 } }],
    [{ ...valid, salesCommissions: { ...fees, USD: 100_001 } }],
    [{ ...valid, salesCommissions: { ...fees, USD: 1.5 } }],
    [{ ...valid, salesCommissions: { ...fees, CAD: "200" } }],
    [{ ...valid, salesCommissions: { USD: 100, CAD: 100 } }],
    [{ ...valid, salesCommissions: { ...fees, EUR: 100 } }],
    [{ ...valid, salesCommissions: 125 }],
    [{ ...valid, salesCommission: 1.25, salesCommissions: undefined }],
    [{ ...valid, isStoreLive: "yes" }],
    [{ storeId: STORE, salesCommissions: fees }],
    [{ ...valid, storeId: "nope" }],
  ])("400 for %j", async (body) => {
    expect((await put(body)).status).toBe(400);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("allows zero commission", async () => {
    ddb.on(UpdateCommand).resolves({});
    expect((await put({ ...valid, salesCommissions: { USD: 0, CAD: 0, AUD: 0 } })).status).toBe(200);
  });

  it("404 for a store that doesn't exist", async () => {
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "no", $metadata: {} }));
    const res = await put(valid);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("STORE_NOT_FOUND");
  });
});

describe("GET /admin/get-store-admin-settings/:storeId", () => {
  it("returns the saved block", async () => {
    ddb.on(GetCommand).resolves({ Item: { pk: "x", admin: { salesCommissions: fees, isStoreLive: false } } });
    expect((await getAdmin()).body).toEqual({ salesCommissions: fees, isStoreLive: false });
  });

  it("turns a flat pre-5.1a commission into the same amount in every currency", async () => {
    ddb.on(GetCommand).resolves({ Item: { pk: "x", admin: { salesCommission: 3, isStoreLive: false } } });
    expect((await getAdmin()).body).toEqual({ salesCommissions: { USD: 300, CAD: 300, AUD: 300 }, isStoreLive: false });
  });

  it("fills in defaults for a store saved before the block existed", async () => {
    ddb.on(GetCommand).resolves({ Item: { pk: "x" } });
    expect((await getAdmin()).body).toEqual({ salesCommissions: { USD: 125, CAD: 125, AUD: 125 }, isStoreLive: true });
  });

  it("404 without a store; 403 for non-admins", async () => {
    ddb.on(GetCommand).resolves({});
    expect((await getAdmin()).status).toBe(404);
    asMember();
    expect((await getAdmin()).status).toBe(403);
  });
});

describe("the admin block is hidden outside the admin area (1.6b)", () => {
  const withSettings = () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(GetCommand).resolves({
      Item: { pk: "p", sk: "s", currencies: [], general: {}, admin: { salesCommission: 9, isStoreLive: true } },
    });
  };
  const getData = (path: string, auth = true) => {
    const r = request(app).get(`/api/v1/store/inventory/${path}/${STORE}`).set("Host", "localhost");
    return auth ? r.set("Authorization", "Bearer t") : r;
  };

  it("store members don't get it from get-data", async () => {
    withSettings();
    asMember();
    const res = await getData("get-data");
    expect(res.status).toBe(200);
    expect(res.body.settings).not.toHaveProperty("admin");
    expect(res.body.settings).toHaveProperty("general");
  });

  it("platform admins still do", async () => {
    withSettings();
    const res = await getData("get-data");
    expect(res.body.settings.admin).toEqual({ salesCommissions: { USD: 900, CAD: 900, AUD: 900 }, isStoreLive: true });
  });

  it("the public storefront never does", async () => {
    withSettings();
    const res = await getData("get-data-public", false);
    expect(res.status).toBe(200);
    expect(res.body.settings).not.toHaveProperty("admin");
  });
});

describe("platformFeeMinor (5.4c application fee)", () => {
  const admin = { salesCommissions: { USD: 125, CAD: 200, AUD: 0 }, isStoreLive: true };
  it("is the store's commission in the charge's currency", () => {
    expect(platformFeeMinor(admin, "CAD", 5000)).toBe(200);
    expect(platformFeeMinor(admin, "AUD", 5000)).toBe(0);
  });
  it("never exceeds the order total", () => {
    expect(platformFeeMinor(admin, "CAD", 150)).toBe(150);
    expect(platformFeeMinor(admin, "USD", 0)).toBe(0);
  });
  it("uses the default for a store without a saved block", () => {
    expect(platformFeeMinor(undefined, "USD", 5000)).toBe(125);
  });
});
