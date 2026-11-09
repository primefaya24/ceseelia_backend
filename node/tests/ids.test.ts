import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { ulid } from "ulid";

vi.mock("../layers/aws/cognito", () => ({
  verifyCognitoAccessToken: vi.fn(),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";
import { isUlid, isUlidOrEmpty } from "../layers/core/utils";
import { initStoreCategory, initStoreSettings } from "../layers/core/interfaces/store";

describe("isUlid", () => {
  it("accepts generated ULIDs", () => {
    for (let i = 0; i < 20; i++) expect(isUlid(ulid())).toBe(true);
  });

  it.each([
    "",
    "01jbz0000000000000000000aa", // lower case would be a different DynamoDB key
    "01JBZ0000000000000000000A", // 25 chars
    "01JBZ0000000000000000000AAA", // 27 chars
    "81JBZ0000000000000000000AA", // timestamp overflow
    "01JBZ0000000000000000000AI", // I is not Crockford base32
    "../../store/01JBZ000000000",
    "01JBZ00000000000#SETTINGS0",
    123,
    null,
    undefined,
    {},
  ])("rejects %j", (id) => {
    expect(isUlid(id)).toBe(false);
  });

  it("isUlidOrEmpty allows a missing ID for creates", () => {
    expect(isUlidOrEmpty(undefined)).toBe(true);
    expect(isUlidOrEmpty(null)).toBe(true);
    expect(isUlidOrEmpty("")).toBe(true);
    expect(isUlidOrEmpty(ulid())).toBe(true);
    expect(isUlidOrEmpty("abc")).toBe(false);
  });
});

describe("routes reject malformed IDs with 400 before touching data", () => {
  const verifyMock = vi.mocked(verifyCognitoAccessToken);
  const app = createApp();
  const ID = ulid();
  const BAD = "not-a-ulid";

  beforeEach(() => {
    verifyMock.mockReset();
    verifyMock.mockResolvedValue({ sub: "admin-1", "cognito:groups": ["Admins"] });
  });

  const asAdmin = (method: "get" | "post" | "put" | "delete", path: string) =>
    request(app)[method](`/api/v1${path}`).set("Host", "localhost").set("Authorization", "Bearer good");

  it.each<["get" | "delete", string]>([
    ["delete", `/store/delete/${BAD}`],
    ["get", `/store/get-logo-upload-url/${BAD}/png`],
    ["get", `/store/get-header-strip-image-upload-url/${BAD}/png`],
    ["get", `/store/get-promo-image-upload-urls/${BAD}/1/1`],
    ["delete", `/store/category/delete/${ID}/${BAD}`],
    ["delete", `/store/category/delete/${BAD}/${ID}`],
    ["get", `/store/category/get-banner-upload-url/${ID}/${BAD}/png`],
    ["delete", `/store/inventory/delete-item/${ID}/${BAD}`],
    ["get", `/store/inventory/get-data/${BAD}`],
    ["get", `/store/inventory/get-item-image-upload-urls/${ID}/${BAD}/1/1`],
  ])("%s %s", async (method, path) => {
    const res = await asAdmin(method, path);
    expect(res.status).toBe(400);
  });

  it("public get-data-public rejects a malformed storeId", async () => {
    const res = await request(app).get(`/api/v1/store/inventory/get-data-public/${BAD}`).set("Host", "localhost");
    expect(res.status).toBe(400);
  });

  it("update-settings rejects a malformed storeId", async () => {
    const res = await asAdmin("put", "/store/update-settings").send({
      storeId: BAD,
      storeSettings: initStoreSettings(),
    });
    expect(res.status).toBe(400);
  });

  it("admin update-store-info rejects a malformed storeId", async () => {
    const res = await asAdmin("post", "/admin/update-store-info").send({
      storeId: BAD,
      storeName: "Shop",
      storeSlug: "shop",
    });
    expect(res.status).toBe(400);
  });

  it("category create needs a valid categoryId on update", async () => {
    const body = { storeId: ID, storeCategory: initStoreCategory("", "Drinks"), isUpdate: true };
    expect((await asAdmin("post", "/store/category/create").send(body)).status).toBe(400);
    expect((await asAdmin("post", "/store/category/create").send({ ...body, categoryId: BAD })).status).toBe(400);
  });

  it("item create rejects a malformed storeItemId", async () => {
    const storeItem = {
      storeItemId: "",
      storeItemCategoryId: ID,
      storeItemImageUris: [],
      storeItemName: "Tea",
      storeItemStock: 1,
      storeItemPrices: { USD: 200 },
      storeItemDescription: "",
      storeItemIsActive: true,
      storeItemHashtagIds: [],
      storeItemDiscountPercent: 0,
      storeItemCustomParams: [],
    };
    const res = await asAdmin("post", "/store/inventory/create-item").send({
      storeId: ID,
      storeItemId: BAD,
      isUpdate: false,
      storeItem,
    });
    expect(res.status).toBe(400);
  });
});
