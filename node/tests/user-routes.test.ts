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
}));

vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", () => ({
  listUserStores: vi.fn(async () => []),
  claimStoreInvites: vi.fn(async () => []),
}));

import { deleteUser, verifyCognitoAccessToken } from "../layers/aws/cognito";
import { updateUserLocale, updateUserProfile } from "../layers/aws/dynamodb/dynamo-entities/user";
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

describe("delete-user (S.11)", () => {
  it("is disabled and deletes nothing", async () => {
    const res = await asUser("delete", "/user/delete-user");
    expect(res.status).toBe(501);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("still requires sign-in", async () => {
    const res = await request(app).delete("/api/v1/user/delete-user").set("Host", "localhost");
    expect(res.status).toBe(401);
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
