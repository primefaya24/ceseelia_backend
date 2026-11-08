import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../layers/aws/cognito", () => ({
  verifyCognitoAccessToken: vi.fn(),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";

const verifyMock = vi.mocked(verifyCognitoAccessToken);
const app = createApp();
const ID = "01JBZ0000000000000000000AA";

// Every authenticated /store/** route. Interim lockdown (progress.md S.0): admin-only until the
// store-membership check (Stage 1.3) replaces it.
const STORE_ROUTES: Array<["get" | "post" | "put" | "delete", string]> = [
  ["post", "/store/create"],
  ["delete", `/store/delete/${ID}`],
  ["put", "/store/update-settings"],
  ["get", `/store/get-logo-upload-url/${ID}/png`],
  ["get", `/store/get-header-strip-image-upload-url/${ID}/png`],
  ["get", `/store/get-promo-image-upload-urls/${ID}/1/1`],
  ["post", "/store/category/create"],
  ["delete", `/store/category/delete/${ID}/${ID}`],
  ["get", `/store/category/get-banner-upload-url/${ID}/${ID}/png`],
  ["post", "/store/inventory/create-item"],
  ["delete", `/store/inventory/delete-item/${ID}/${ID}`],
  ["get", `/store/inventory/get-data/${ID}`],
  ["get", `/store/inventory/get-item-image-upload-urls/${ID}/${ID}/1/1`],
];

function call(method: (typeof STORE_ROUTES)[number][0], path: string) {
  return request(app)[method](`/api/v1${path}`).set("Host", "localhost");
}

beforeEach(() => {
  verifyMock.mockReset();
});

describe("store routes (interim admin-only lockdown)", () => {
  it.each(STORE_ROUTES)("%s %s returns 401 without a token", async (method, path) => {
    const res = await call(method, path);
    expect(res.status).toBe(401);
  });

  it.each(STORE_ROUTES)("%s %s returns 403 for a signed-in non-admin", async (method, path) => {
    verifyMock.mockResolvedValue({ sub: "merchant-1", "cognito:groups": [] });
    const res = await call(method, path).set("Authorization", "Bearer good");
    expect(res.status).toBe(403);
  });

  it("lets admins through the gate (reaches param validation)", async () => {
    verifyMock.mockResolvedValue({ sub: "admin-1", "cognito:groups": ["Admins"] });
    const res = await call("put", "/store/update-settings").set("Authorization", "Bearer good").send({});
    expect(res.status).toBe(400);
  });
});
