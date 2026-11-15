import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../layers/aws/cognito", () => ({
  verifyCognitoAccessToken: vi.fn(),
  deleteUser: vi.fn(),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchUserUUID: vi.fn(async () => "USER1"),
  findUserIdByCognitoId: vi.fn(async () => "USER1"),
  getMyProfile: vi.fn(async () => ({ info: {} })),
  updateUserLocale: vi.fn(async () => undefined),
  updateUserProfile: vi.fn(async () => undefined),
  fetchUserCognitoItems: vi.fn(async () => [{ userCognitoId: "cognito-1", userSocialProviderType: "" }]),
  deleteUserRows: vi.fn(async () => 4),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/support-ticket", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deleteUserTickets: vi.fn(async () => 1),
}));

vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", () => ({
  listUserStores: vi.fn(async () => []),
  claimStoreInvites: vi.fn(async () => []),
  userStoreIds: vi.fn(async () => []),
  listStoreMemberIds: vi.fn(async () => []),
  removeStoreMember: vi.fn(async () => undefined),
  getStoreOverviewRow: vi.fn(async () => ({ storeName: "Hoop" })),
}));

import { deleteUser, verifyCognitoAccessToken } from "../layers/aws/cognito";
import { deleteUserRows, updateUserLocale, updateUserProfile } from "../layers/aws/dynamodb/dynamo-entities/user";
import { listStoreMemberIds, removeStoreMember, userStoreIds } from "../layers/aws/dynamodb/dynamo-entities/membership";
import { deleteUserTickets } from "../layers/aws/dynamodb/dynamo-entities/support-ticket";
import { deleteAccountLimit } from "../api/v1/user/delete-user";
import { createApp } from "../app";

const app = createApp();
const asUser = (method: "get" | "delete", path: string) =>
  request(app)[method](`/api/v1${path}`).set("Host", "localhost").set("Authorization", "Bearer good");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "cognito-1", "cognito:groups": [] });
});

describe("get-my-profile locale (S.10)", () => {
  it.each(["en", "id"])("saves a supported locale: %s", async (locale) => {
    const res = await asUser("get", `/user/get-my-profile/${locale}`);
    expect(res.status).toBe(200);
    expect(updateUserLocale).toHaveBeenCalledWith("USER1", locale);
  });

  it.each(["fr", "EN", "en-US", "x".repeat(500), "%3Cscript%3E"])("rejects %s without saving it", async (locale) => {
    const res = await asUser("get", `/user/get-my-profile/${locale}`);
    expect(res.status).toBe(400);
    expect(updateUserLocale).not.toHaveBeenCalled();
  });

  it("looks the user up by the token's identity, not the body", async () => {
    const { findUserIdByCognitoId } = await import("../layers/aws/dynamodb/dynamo-entities/user");
    await asUser("get", "/user/get-my-profile").query({}).send();
    expect(findUserIdByCognitoId).toHaveBeenCalledWith("cognito-1");
  });

  it("works without a locale", async () => {
    const res = await asUser("get", "/user/get-my-profile");
    expect(res.status).toBe(200);
    expect(updateUserLocale).not.toHaveBeenCalled();
  });
});

describe("delete-user (L.9)", () => {
  const del = (body?: object) => {
    const r = request(app).delete("/api/v1/user/delete-user").set("Host", "localhost").set("Authorization", "Bearer good");
    return body ? r.send(body) : r;
  };
  beforeEach(() => deleteAccountLimit.reset());

  it("needs the typed confirmation and sign-in; deletes nothing otherwise", async () => {
    expect((await del()).status).toBe(400);
    expect((await del({ confirm: "delete" })).status).toBe(400);
    expect((await request(app).delete("/api/v1/user/delete-user").set("Host", "localhost").send({ confirm: "DELETE" })).status).toBe(401);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("refuses an admin account", async () => {
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "cognito-1", "cognito:groups": ["Admins"] });
    const res = await del({ confirm: "DELETE" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ADMIN_ACCOUNT");
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("refuses the only member of a store", async () => {
    vi.mocked(userStoreIds).mockResolvedValueOnce(["S1"]);
    vi.mocked(listStoreMemberIds).mockResolvedValueOnce(["USER1"]);
    const res = await del({ confirm: "DELETE" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "ONLY_MEMBER", storeName: "Hoop" });
    expect(removeStoreMember).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(deleteUserRows).not.toHaveBeenCalled();
  });

  it("leaves the store, deletes tickets, then the logins, then the rows", async () => {
    vi.mocked(userStoreIds).mockResolvedValueOnce(["S1"]);
    vi.mocked(listStoreMemberIds).mockResolvedValueOnce(["USER1", "USER2"]);
    const order: string[] = [];
    vi.mocked(removeStoreMember).mockImplementationOnce(async () => void order.push("member"));
    vi.mocked(deleteUserTickets).mockImplementationOnce(async () => (order.push("tickets"), 1));
    vi.mocked(deleteUser).mockImplementationOnce(async () => void order.push("cognito"));
    vi.mocked(deleteUserRows).mockImplementationOnce(async () => (order.push("rows"), 4));
    const res = await del({ confirm: "DELETE" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(removeStoreMember).toHaveBeenCalledWith("S1", "USER1");
    expect(order).toEqual(["member", "tickets", "cognito", "rows"]);
  });

  it("a failed login delete keeps the rows, so the user can try again", async () => {
    vi.mocked(deleteUser).mockRejectedValueOnce(new Error("x"));
    expect((await del({ confirm: "DELETE" })).status).toBe(500);
    expect(deleteUserRows).not.toHaveBeenCalled();
  });

  it("3 tries an hour", async () => {
    for (let i = 0; i < 3; i++) await del({ confirm: "DELETE" });
    expect((await del({ confirm: "DELETE" })).status).toBe(429);
  });
});

describe("update-profile (WA 1.6a)", () => {
  const put = (body: object) =>
    request(app).put("/api/v1/user/update-profile").set("Host", "localhost").set("Authorization", "Bearer good").send(body);

  it("saves trimmed names for the signed-in user", async () => {
    const res = await put({ userFirstName: "  Ada ", userLastName: "Lovelace  " });
    expect(res.status).toBe(200);
    expect(updateUserProfile).toHaveBeenCalledWith("USER1", "Ada", "Lovelace");
  });

  it.each([
    [{ userFirstName: "", userLastName: "L" }],
    [{ userFirstName: "A", userLastName: "   " }],
    [{ userFirstName: "x".repeat(51), userLastName: "L" }],
    [{ userFirstName: "A" }],
    [{ userFirstName: 1, userLastName: "L" }],
  ])("rejects %j without saving", async (body) => {
    expect((await put(body)).status).toBe(400);
    expect(updateUserProfile).not.toHaveBeenCalled();
  });

  it("accepts exactly 50 characters", async () => {
    expect((await put({ userFirstName: "x".repeat(50), userLastName: "L" })).status).toBe(200);
  });
});
