import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { ulid } from "ulid";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";
import {
  deleteStoreItem,
  StoreRecordNotFoundError,
  updateStoreItem,
} from "../layers/aws/dynamodb/dynamo-entities/store";
import { StoreItem } from "../layers/core/interfaces/store";

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);
const STORE = ulid();
const ITEM = ulid();
const OLD = ulid();
const NEW = ulid();
const PK = `STORE#${STORE}`;

const cancelled = (codes: string[]) =>
  Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

const item = (categoryId: string): StoreItem => ({
  storeItemId: "",
  storeItemCategoryId: categoryId,
  storeItemImageUris: [],
  storeItemName: "Tea",
  storeItemStock: 1,
  storeItemPrices: { USD: 200 },
  storeItemDescription: "",
  storeItemIsActive: true,
  storeItemHashtagIds: [],
  storeItemDiscountPercent: 0,
  storeItemCustomParams: [],
});

/* Stored rows the GetCommands see: the item (with its category) and which categories exist. */
function stored({ itemCategory = OLD as string | null, categories = [OLD, NEW] } = {}) {
  ddb.on(GetCommand).callsFake((input) => {
    const sk: string = input.Key.sk;
    if (sk === `ITEM#${ITEM}`) return itemCategory === null ? {} : { Item: { storeItemCategoryId: itemCategory } };
    if (sk.startsWith("CATEGORY#")) return categories.includes(sk.slice(9)) ? { Item: { pk: PK } } : {};
    return {};
  });
}
const tx = (i = 0) => ddb.commandCalls(TransactWriteCommand)[i].args[0].input.TransactItems!;
/* The category count changes in a transaction, as "<categoryId> <delta>". */
const countChanges = (i = 0) =>
  tx(i)
    .filter((t) => t.Update?.UpdateExpression === "ADD storeCategoryItemCount :delta")
    .map((t) => `${(t.Update!.Key!.sk as string).slice(9)} ${t.Update!.ExpressionAttributeValues![":delta"]}`);

beforeEach(() => {
  ddb.reset();
  s3.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("item create keeps the category count (2.1)", () => {
  it("adds 1 to the item's category in the same transaction, only if the category exists", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const id = await updateStoreItem(STORE, item(NEW), undefined, false);
    expect(countChanges()).toEqual([`${NEW} 1`]);
    const change = tx()[2].Update!;
    expect(change.Key).toEqual({ pk: PK, sk: `CATEGORY#${NEW}` });
    expect(change.ConditionExpression).toBe("attribute_exists(pk)");
    expect(tx()[1].Update!.Key).toEqual({ pk: PK, sk: `ITEM#${id}` });
  });

  it("a missing category is Category not found (and nothing is written)", async () => {
    ddb.on(TransactWriteCommand).rejects(cancelled(["None", "None", "ConditionalCheckFailed"]));
    await expect(updateStoreItem(STORE, item(NEW), undefined, false)).rejects.toThrow("Category not found");
  });
});

describe("item update keeps the category counts (2.1)", () => {
  it("same category: no count change, but still guarded on the category it had", async () => {
    stored();
    ddb.on(TransactWriteCommand).resolves({});
    await updateStoreItem(STORE, item(OLD), ITEM, true);
    expect(tx()).toHaveLength(1);
    expect(tx()[0].Update!.ConditionExpression).toBe("attribute_exists(pk) AND storeItemCategoryId = :oldCategoryId");
    expect(tx()[0].Update!.ExpressionAttributeValues![":oldCategoryId"]).toBe(OLD);
  });

  it("moving category: +1 new, -1 old, with the item write", async () => {
    stored();
    ddb.on(TransactWriteCommand).resolves({});
    await updateStoreItem(STORE, item(NEW), ITEM, true);
    expect(countChanges()).toEqual([`${NEW} 1`, `${OLD} -1`]);
  });

  it("moving out of a category that's already gone (pre-2.2 orphan): only +1 new", async () => {
    stored({ categories: [NEW] });
    ddb.on(TransactWriteCommand).resolves({});
    await updateStoreItem(STORE, item(NEW), ITEM, true);
    expect(countChanges()).toEqual([`${NEW} 1`]);
  });

  it("moving into a category that doesn't exist is Category not found", async () => {
    stored();
    ddb.on(TransactWriteCommand).rejects(cancelled(["None", "ConditionalCheckFailed", "None"]));
    await expect(updateStoreItem(STORE, item(NEW), ITEM, true)).rejects.toThrow("Category not found");
  });

  it("a missing item is Item not found, with no write", async () => {
    stored({ itemCategory: null });
    await expect(updateStoreItem(STORE, item(NEW), ITEM, true)).rejects.toBeInstanceOf(StoreRecordNotFoundError);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("retries when the item moved between the read and the write, then gives up after 3", async () => {
    stored();
    ddb
      .on(TransactWriteCommand)
      .rejectsOnce(cancelled(["ConditionalCheckFailed", "None", "None"]))
      .resolves({});
    await updateStoreItem(STORE, item(NEW), ITEM, true);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(2);

    ddb.reset();
    stored();
    ddb.on(TransactWriteCommand).rejects(cancelled(["ConditionalCheckFailed", "None", "None"]));
    await expect(updateStoreItem(STORE, item(NEW), ITEM, true)).rejects.toThrow(/gave up/);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(3);
  });
});

describe("item delete keeps the category count (2.1)", () => {
  it("deletes the item and takes 1 off its category, in one transaction", async () => {
    stored();
    ddb.on(TransactWriteCommand).resolves({});
    expect(await deleteStoreItem(STORE, ITEM)).toBe(true);
    expect(tx()[0].Delete!.Key).toEqual({ pk: PK, sk: `ITEM#${ITEM}` });
    expect(tx()[0].Delete!.ConditionExpression).toBe("attribute_exists(pk) AND storeItemCategoryId = :categoryId");
    expect(countChanges()).toEqual([`${OLD} -1`]);
  });

  it("an item in a category that's gone is deleted without a count change", async () => {
    stored({ categories: [] });
    ddb.on(TransactWriteCommand).resolves({});
    await deleteStoreItem(STORE, ITEM);
    expect(tx()).toHaveLength(1);
  });

  it("an item that's already gone: nothing to do", async () => {
    stored({ itemCategory: null });
    expect(await deleteStoreItem(STORE, ITEM)).toBe(false);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe("DELETE /store/inventory/delete-item (2.1)", () => {
  const app = createApp();
  const del = () =>
    request(app)
      .delete(`/api/v1/store/inventory/delete-item/${STORE}/${ITEM}`)
      .set("Host", "localhost")
      .set("Authorization", "Bearer good");

  beforeEach(() => {
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "admin-1", "cognito:groups": ["Admins"] });
  });

  it("deletes the item before its images", async () => {
    const order: string[] = [];
    stored();
    ddb.on(TransactWriteCommand).callsFake(() => (order.push("item"), {}));
    s3.on(ListObjectsV2Command).callsFake(() => {
      order.push("list");
      return { Contents: [{ Key: `store/${STORE}/item/${ITEM}/images/a.png` }] };
    });
    s3.on(DeleteObjectsCommand).callsFake(() => (order.push("files"), {}));
    expect((await del()).status).toBe(200);
    expect(order).toEqual(["item", "list", "files"]);
  });

  it("keeps the images when the item delete fails", async () => {
    stored();
    ddb.on(TransactWriteCommand).rejects(new Error("throttled"));
    expect((await del()).status).toBe(500);
    expect(s3.calls()).toHaveLength(0);
  });
});
