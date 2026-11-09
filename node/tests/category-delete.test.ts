import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { ulid } from "ulid";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";
import { CategoryNotEmptyError, deleteStoreCategory } from "../layers/aws/dynamodb/dynamo-entities/store";

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);
const STORE = ulid();
const CATEGORY = ulid();

/* What DynamoDB throws when the count condition fails, with the item as stored. */
const notEmpty = (count: unknown) =>
  new ConditionalCheckFailedException({
    message: "The conditional request failed",
    $metadata: {},
    Item: { storeCategoryItemCount: count } as never,
  });

beforeEach(() => {
  ddb.reset();
  s3.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("deleteStoreCategory (2.2)", () => {
  it("deletes only while the category has no items (or is already gone)", async () => {
    ddb.on(DeleteCommand).resolves({});
    await deleteStoreCategory(STORE, CATEGORY);
    const input = ddb.commandCalls(DeleteCommand)[0].args[0].input;
    expect(input.Key).toEqual({ pk: `STORE#${STORE}`, sk: `CATEGORY#${CATEGORY}` });
    expect(input.ConditionExpression).toBe(
      "attribute_not_exists(pk) OR attribute_not_exists(storeCategoryItemCount) OR storeCategoryItemCount <= :zero"
    );
    expect(input.ExpressionAttributeValues).toEqual({ ":zero": 0 });
    expect(input.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD");
  });

  it.each([
    [{ N: "3" }, 3, "This category still has 3 items. Move or delete them first."],
    [1, 1, "This category still has 1 item. Move or delete it first."],
    [undefined, 1, "This category still has 1 item. Move or delete it first."],
  ])("refuses a category with items (stored count %j)", async (stored, itemCount, message) => {
    ddb.on(DeleteCommand).rejects(notEmpty(stored));
    const err = await deleteStoreCategory(STORE, CATEGORY).catch((e) => e);
    expect(err).toBeInstanceOf(CategoryNotEmptyError);
    expect(err).toMatchObject({ itemCount, message });
  });

  it("other errors pass through", async () => {
    ddb.on(DeleteCommand).rejects(new Error("throttled"));
    await expect(deleteStoreCategory(STORE, CATEGORY)).rejects.toThrow("throttled");
  });
});

describe("DELETE /store/category/delete (2.2)", () => {
  const app = createApp();
  const del = () =>
    request(app)
      .delete(`/api/v1/store/category/delete/${STORE}/${CATEGORY}`)
      .set("Host", "localhost")
      .set("Authorization", "Bearer good");

  beforeEach(() => {
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "admin-1", "cognito:groups": ["Admins"] });
  });

  it("409 CATEGORY_NOT_EMPTY with the count, and the banner is kept", async () => {
    ddb.on(DeleteCommand).rejects(notEmpty({ N: "2" }));
    const res = await del();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: "CATEGORY_NOT_EMPTY",
      message: "This category still has 2 items. Move or delete them first.",
      itemCount: 2,
    });
    expect(s3.calls()).toHaveLength(0);
  });

  it("an empty category: deletes the row, then its banner", async () => {
    const order: string[] = [];
    ddb.on(DeleteCommand).callsFake(() => (order.push("category"), {}));
    s3.on(ListObjectsV2Command).callsFake(() => {
      order.push("list");
      return { Contents: [{ Key: `store/${STORE}/category/${CATEGORY}/images/b.png` }] };
    });
    s3.on(DeleteObjectsCommand).callsFake(() => (order.push("files"), {}));
    expect((await del()).status).toBe(200);
    expect(order).toEqual(["category", "list", "files"]);
  });

  it("500 (banner kept) when the delete fails for another reason", async () => {
    ddb.on(DeleteCommand).rejects(new Error("throttled"));
    expect((await del()).status).toBe(500);
    expect(s3.calls()).toHaveLength(0);
  });
});
