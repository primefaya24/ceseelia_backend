import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../layers/aws/cognito", () => ({
  verifyCognitoAccessToken: vi.fn(),
  deleteUser: vi.fn(),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchUserUUID: vi.fn(async () => "USER1"),
  getMyProfile: vi.fn(async () => ({ info: {} })),
  updateUserLocale: vi.fn(async () => undefined),
}));

import { deleteUser, verifyCognitoAccessToken } from "../layers/aws/cognito";
import { updateUserLocale } from "../layers/aws/dynamodb/dynamo-entities/user";
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
