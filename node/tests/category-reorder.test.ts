import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";
import {
  CategoriesChangedError,
  reorderStoreCategories,
  updateStoreCategory,
} from "../layers/aws/dynamodb/dynamo-entities/store";
import { initStoreCategory, isStoreCategoryPure, isStoreCategoryValid } from "../layers/core/interfaces/store";

const ddb = mockClient(DynamoDBDocumentClient);
const STORE = ulid();
const [A, B, C] = [ulid(), ulid(), ulid()];
const rows = (ids: string[]) => ids.map((id) => ({ pk: `STORE#${STORE}`, sk: `CATEGORY#${id}`, storeCategoriyId: id }));

beforeEach(() => {
  ddb.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("reorderStoreCategories", () => {
  it("numbers every category in the order sent, each only if it still exists", async () => {
    ddb.on(QueryCommand).resolves({ Items: rows([A, B, C]) });
    ddb.on(TransactWriteCommand).resolves({});
    await reorderStoreCategories(STORE, [C, A, B]);
    const items = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(items.map((t) => [t.Update!.Key!.sk, t.Update!.ExpressionAttributeValues![":order"]])).toEqual([
      [`CATEGORY#${C}`, 0],
      [`CATEGORY#${A}`, 1],
      [`CATEGORY#${B}`, 2],
    ]);
    expect(items[0].Update!.UpdateExpression).toBe("SET storeCategoryOrder = :order");
    expect(items[0].Update!.ConditionExpression).toBe("attribute_exists(pk)");
  });

  it.each([
    ["one missing", [A, B]],
    ["an unknown one", [A, B, ulid()]],
  ])("refuses a list that doesn't match the store's categories (%s)", async (_label, ids) => {
    ddb.on(QueryCommand).resolves({ Items: rows([A, B, C]) });
    await expect(reorderStoreCategories(STORE, ids)).rejects.toBeInstanceOf(CategoriesChangedError);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("a category deleted meanwhile cancels the write", async () => {
    ddb.on(QueryCommand).resolves({ Items: rows([A, B]) });
    ddb.on(TransactWriteCommand).rejects(new TransactionCanceledException({ message: "x", $metadata: {} }));
    await expect(reorderStoreCategories(STORE, [B, A])).rejects.toBeInstanceOf(CategoriesChangedError);
  });

  it("writes more than 100 categories in several transactions", async () => {
    const ids = Array.from({ length: 150 }, () => ulid());
    ddb.on(QueryCommand).resolves({ Items: rows(ids) });
    ddb.on(TransactWriteCommand).resolves({});
    await reorderStoreCategories(STORE, ids);
    expect(ddb.commandCalls(TransactWriteCommand).map((c) => c.args[0].input.TransactItems!.length)).toEqual([100, 50]);
  });
});

describe("POST /store/category/reorder", () => {
  const app = createApp();
  const post = (body: object) =>
    request(app)
      .post("/api/v1/store/category/reorder")
      .set("Host", "localhost")
      .set("Authorization", "Bearer good")
      .send(body);

  beforeEach(() => {
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "admin-1", "cognito:groups": ["Admins"] });
  });

  it("saves the order", async () => {
    ddb.on(QueryCommand).resolves({ Items: rows([A, B]) });
    ddb.on(TransactWriteCommand).resolves({});
    const res = await post({ storeId: STORE, categoryIds: [B, A] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("409 CATEGORIES_CHANGED when the list is out of date", async () => {
    ddb.on(QueryCommand).resolves({ Items: rows([A, B, C]) });
    const res = await post({ storeId: STORE, categoryIds: [B, A] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CATEGORIES_CHANGED");
  });

  it.each([
    ["no list", { storeId: STORE }],
    ["an empty list", { storeId: STORE, categoryIds: [] }],
    ["a repeated id", { storeId: STORE, categoryIds: [A, A] }],
    ["a bad id", { storeId: STORE, categoryIds: ["nope"] }],
    ["a bad store", { storeId: "x", categoryIds: [A] }],
  ])("400 for %s", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe("category priority retired (owner, 2026-11-23)", () => {
  it("a new category has no priority; one without is accepted, an old webapp's is accepted but not written", async () => {
    const fresh = initStoreCategory("", "Tea");
    expect(fresh).not.toHaveProperty("storeCategoriyPriority");
    expect(isStoreCategoryPure(fresh) && isStoreCategoryValid(fresh, STORE, undefined)).toBe(true);
    const old = { ...fresh, storeCategoriyPriority: "PRIORITY_HIGHT" as const, storeCategoryOrder: 7 };
    expect(isStoreCategoryPure(old) && isStoreCategoryValid(old, STORE, undefined)).toBe(true);

    ddb.on(TransactWriteCommand).resolves({});
    await updateStoreCategory(STORE, old, undefined, false);
    const update = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!.find((t) => t.Update)!.Update!;
    expect(update.UpdateExpression).not.toMatch(/storeCategoriyPriority|storeCategoryOrder/);
    expect(Object.keys(update.ExpressionAttributeValues!)).not.toContain(":storeCategoriyPriority");
  });
});
