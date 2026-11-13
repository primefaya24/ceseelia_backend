import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../layers/aws/cognito", () => ({
  verifyCognitoAccessToken: vi.fn(),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  findUserIdByCognitoId: vi.fn(),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getMembership: vi.fn(),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/store", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/store")>()),
  getStoreInventoryData: vi.fn(async () => ({ categories: [], items: [], settings: {} })),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { findUserIdByCognitoId, UserDeactivatedError } from "../layers/aws/dynamodb/dynamo-entities/user";
import { getMembership } from "../layers/aws/dynamodb/dynamo-entities/membership";
import { createApp } from "../app";
import { assertStoreAccess } from "../layers/core/http";

const verifyMock = vi.mocked(verifyCognitoAccessToken);
const findUserMock = vi.mocked(findUserIdByCognitoId);
const membershipMock = vi.mocked(getMembership);
const app = createApp();
const STORE = "01JBZ0000000000000000000AA";
const OTHER = "01JBZ0000000000000000000BB";
const ID = "01JBZ0000000000000000000CC";

type Method = "get" | "post" | "put" | "delete";
// Store-member routes (progress.md 1.3): [method, path, body]. The store id is STORE in each.
const MEMBER_ROUTES: Array<[Method, string, object | undefined]> = [
  ["get", `/store/go-live/checklist/${STORE}`, undefined],
  ["get", `/store/billing/status/${STORE}`, undefined],
  ["post", "/store/billing/portal", { storeId: STORE }],
  ["put", "/store/update-settings", { storeId: STORE }],
  ["get", `/store/get-logo-upload-url/${STORE}/png`, undefined],
  ["get", `/store/get-header-strip-image-upload-url/${STORE}/png`, undefined],
  ["get", `/store/get-promo-image-upload-urls/${STORE}/1/1`, undefined],
  ["post", "/store/category/create", { storeId: STORE }],
  ["delete", `/store/category/delete/${STORE}/${ID}`, undefined],
  ["get", `/store/category/get-banner-upload-url/${STORE}/${ID}/png`, undefined],
  ["post", "/store/inventory/create-item", { storeId: STORE }],
  ["delete", `/store/inventory/delete-item/${STORE}/${ID}`, undefined],
  ["get", `/store/inventory/get-data/${STORE}`, undefined],
  ["get", `/store/inventory/get-item-image-upload-urls/${STORE}/${ID}/1/1`, undefined],
];
const ADMIN_ROUTES: Array<[Method, string, object | undefined]> = [
  ["post", "/store/create", {}],
  ["delete", `/store/delete/${STORE}`, undefined],
];

function call(method: Method, path: string, body?: object, token = true) {
  let r = request(app)[method](`/api/v1${path}`).set("Host", "localhost");
  if (token) r = r.set("Authorization", "Bearer good");
  return body ? r.send(body) : r;
}
const asUser = () => verifyMock.mockResolvedValue({ sub: "sub-1", "cognito:groups": [] });
const asAdmin = () => verifyMock.mockResolvedValue({ sub: "sub-admin", "cognito:groups": ["Admins"] });
const isMemberOf = (storeId: string, role: "ADMIN" | "MERCHANT" = "MERCHANT") =>
  membershipMock.mockImplementation(async (s, u) => (s === storeId ? { storeId: s, userId: u, role, createdAt: 1 } : null));

beforeEach(() => {
  verifyMock.mockReset();
  findUserMock.mockReset().mockResolvedValue("USER1");
  membershipMock.mockReset().mockResolvedValue(null);
});

describe("store routes: access matrix (1.3)", () => {
  const ALL = [...MEMBER_ROUTES, ...ADMIN_ROUTES];

  it.each(ALL)("%s %s: no token → 401", async (method, path, body) => {
    expect((await call(method, path, body, false)).status).toBe(401);
  });

  it.each(MEMBER_ROUTES)("%s %s: non-member → 403", async (method, path, body) => {
    asUser();
    const res = await call(method, path, body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("STORE_ACCESS_DENIED");
    expect(membershipMock).toHaveBeenCalledWith(STORE, "USER1");
  });

  it.each(MEMBER_ROUTES)("%s %s: member of another store → 403", async (method, path, body) => {
    asUser();
    isMemberOf(OTHER);
    expect((await call(method, path, body)).status).toBe(403);
  });

  // Passing the gate: anything but 401/403 (validation 400, the route's own answer, or a 500 from
  // the sandboxed DB on routes this test doesn't mock).
  const passed = (status: number) => expect([401, 403]).not.toContain(status);
  it.each(MEMBER_ROUTES)("%s %s: member → past the gate", async (method, path, body) => {
    asUser();
    isMemberOf(STORE);
    passed((await call(method, path, body)).status);
  });

  it.each(MEMBER_ROUTES)("%s %s: admin → past the gate, no membership lookup", async (method, path, body) => {
    asAdmin();
    passed((await call(method, path, body)).status);
    expect(findUserMock).not.toHaveBeenCalled();
    expect(membershipMock).not.toHaveBeenCalled();
  });

  it.each(ADMIN_ROUTES)("%s %s stays admin-only, even for a store member", async (method, path, body) => {
    asUser();
    isMemberOf(STORE, "ADMIN");
    expect((await call(method, path, body)).status).toBe(403);
  });

  it("member gets 200 with the store's data", async () => {
    asUser();
    isMemberOf(STORE);
    const res = await call("get", `/store/inventory/get-data/${STORE}`);
    expect(res.status).toBe(200);
  });

  it("admin gets 200 with the store's data", async () => {
    asAdmin();
    expect((await call("get", `/store/inventory/get-data/${STORE}`)).status).toBe(200);
  });

  it("a signed-in user with no profile → 403", async () => {
    asUser();
    findUserMock.mockResolvedValue(null);
    expect((await call("get", `/store/inventory/get-data/${STORE}`)).status).toBe(403);
    expect(membershipMock).not.toHaveBeenCalled();
  });

  it("a deactivated user → 403 ACCOUNT_DEACTIVATED", async () => {
    asUser();
    findUserMock.mockRejectedValue(new UserDeactivatedError());
    const res = await call("get", `/store/inventory/get-data/${STORE}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_DEACTIVATED");
  });

  it.each([
    ["missing", {}],
    ["not a string", { storeId: 42 }],
    ["not a ULID", { storeId: "../x" }],
  ])("body store id %s → 400 before any lookup", async (_label, body) => {
    asUser();
    expect((await call("put", "/store/update-settings", body)).status).toBe(400);
    expect(findUserMock).not.toHaveBeenCalled();
  });

  it("a lookup failure is a 500, not access", async () => {
    asUser();
    membershipMock.mockRejectedValue(new Error("DynamoDB down"));
    expect((await call("get", `/store/inventory/get-data/${STORE}`)).status).toBe(500);
  });

  it.each([
    ["MERCHANT", "ADMIN", false],
    ["ADMIN", "ADMIN", true],
    ["ADMIN", "MERCHANT", true],
  ] as const)("a %s member with minimum role %s → allowed=%s", async (has, needs, allowed) => {
    isMemberOf(STORE, has);
    const sent: number[] = [];
    const res: any = {
      locals: { auth: { cognitoId: "sub-1", groups: [], isAdmin: false } },
      status(code: number) { sent.push(code); return this; },
      send() { return this; },
    };
    expect(await assertStoreAccess(res, STORE, needs)).toBe(allowed);
    expect(sent).toEqual(allowed ? [] : [403]);
    if (allowed) expect(res.locals.auth).toMatchObject({ userId: "USER1", storeRole: has });
  });
});
