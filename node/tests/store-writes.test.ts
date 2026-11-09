import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { ulid } from "ulid";

vi.mock("../layers/aws/cognito", () => ({
  verifyCognitoAccessToken: vi.fn(),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";
import {
  StoreRecordNotFoundError,
  updateStoreCategory,
  updateStoreItem,
  updateStoreSettings,
} from "../layers/aws/dynamodb/dynamo-entities/store";
import { initStoreCategory, initStoreSettings, StoreItem } from "../layers/core/interfaces/store";

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);

const conditionFailed = () => new ConditionalCheckFailedException({ message: "failed", $metadata: {} });
const txCancelled = (codes: string[]) =>
  new TransactionCanceledException({
    message: "cancelled",
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

const item = (): StoreItem => ({
  storeItemId: "",
  storeItemCategoryId: ulid(),
  storeItemImageUris: [],
  storeItemName: "Tea",
  storeItemStock: 1,
  storeItemPrice: 2,
  storeItemDescription: "",
  storeItemIsActive: true,
  storeItemHashtagIds: [],
  storeItemDiscountPercent: 0,
  storeItemCustomParams: [],
});

beforeEach(() => {
  ddb.reset();
  s3.reset();
  s3.onAnyCommand().resolves({});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("store settings writes", () => {
  it("only updates an existing SETTINGS row", async () => {
    ddb.on(UpdateCommand).resolves({});
    await updateStoreSettings("S1", initStoreSettings());
    expect(ddb.commandCalls(UpdateCommand)[0].args[0].input.ConditionExpression).toBe("attribute_exists(pk)");
  });

  it("reports a missing store as StoreRecordNotFoundError", async () => {
    ddb.on(UpdateCommand).rejects(conditionFailed());
    await expect(updateStoreSettings("S1", initStoreSettings())).rejects.toThrow(StoreRecordNotFoundError);
  });
});

describe.each([
  ["Item", (id: string | undefined, isUpdate: boolean) => updateStoreItem("S1", item(), id, isUpdate), "ITEM"],
  [
    "Category",
    (id: string | undefined, isUpdate: boolean) => updateStoreCategory("S1", initStoreCategory("", "Drinks"), id, isUpdate),
    "CATEGORY",
  ],
] as const)("%s writes", (entity, write, skPrefix) => {
  it("create ignores a client ID, checks the store exists and never overwrites", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const id = await write("EXISTINGID", false);

    expect(id).not.toBe("EXISTINGID");
    expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    const [check, update] = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(check.ConditionCheck).toMatchObject({
      Key: { pk: "STORE#S1", sk: "SETTINGS" },
      ConditionExpression: "attribute_exists(pk)",
    });
    expect(update.Update).toMatchObject({
      Key: { pk: "STORE#S1", sk: `${skPrefix}#${id}` },
      ConditionExpression: "attribute_not_exists(pk)",
    });
  });

  it("create in a store that doesn't exist fails with Store not found", async () => {
    ddb.on(TransactWriteCommand).rejects(txCancelled(["ConditionalCheckFailed", "None"]));
    await expect(write(undefined, false)).rejects.toThrow("Store not found");
  });

  it("update writes the given ID only if the row exists", async () => {
    ddb.on(UpdateCommand).resolves({});
    expect(await write("ID1", true)).toBe("ID1");
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual({ pk: "STORE#S1", sk: `${skPrefix}#ID1` });
    expect(input.ConditionExpression).toBe("attribute_exists(pk)");
  });

  it("update of a missing row fails with not found", async () => {
    ddb.on(UpdateCommand).rejects(conditionFailed());
    await expect(write("ID1", true)).rejects.toThrow(`${entity} not found`);
  });

  it("update without an ID is refused", async () => {
    await expect(write(undefined, true)).rejects.toThrow();
    expect(ddb.calls()).toHaveLength(0);
  });
});

describe("routes return 404 for missing records", () => {
  const app = createApp();
  const ID = ulid();
  const asAdmin = (method: "post" | "put", path: string) =>
    request(app)[method](`/api/v1${path}`).set("Host", "localhost").set("Authorization", "Bearer good");

  beforeEach(() => {
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "admin-1", "cognito:groups": ["Admins"] });
  });

  it("update-settings on an unknown store", async () => {
    ddb.on(UpdateCommand).rejects(conditionFailed());
    const res = await asAdmin("put", "/store/update-settings").send({ storeId: ID, storeSettings: initStoreSettings() });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Store not found");
    expect(s3.calls()).toHaveLength(0); // no image cleanup after a failed write
  });

  it("create-item in an unknown store", async () => {
    ddb.on(TransactWriteCommand).rejects(txCancelled(["ConditionalCheckFailed", "None"]));
    const res = await asAdmin("post", "/store/inventory/create-item").send({ storeId: ID, isUpdate: false, storeItem: item() });
    expect(res.status).toBe(404);
  });

  it("category update of an unknown category", async () => {
    ddb.on(UpdateCommand).rejects(conditionFailed());
    const res = await asAdmin("post", "/store/category/create").send({
      storeId: ID,
      categoryId: ulid(),
      isUpdate: true,
      storeCategory: initStoreCategory("", "Drinks"),
    });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Category not found");
  });

  it("create returns the new ID", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const res = await asAdmin("post", "/store/inventory/create-item").send({
      storeId: ID,
      storeItemId: ulid(),
      isUpdate: false,
      storeItem: item(),
    });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });
});

describe("image cleanup runs only after a successful write", () => {
  const app = createApp();
  const STORE = ulid();
  const ID = ulid();
  const asAdmin = (path: string) =>
    request(app).post(`/api/v1${path}`).set("Host", "localhost").set("Authorization", "Bearer good");

  beforeEach(() => {
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "admin-1", "cognito:groups": ["Admins"] });
  });

  const categoryFolder = `store/${STORE}/category/${ID}/images/`;
  const itemFolder = `store/${STORE}/item/${ID}/images/`;
  const KEEP = `${ulid()}.png`;
  const cases = [
    [
      "category",
      "/store/category/create",
      {
        storeId: STORE,
        categoryId: ID,
        isUpdate: true,
        storeCategory: { ...initStoreCategory("", "Drinks"), storeCategoryBannerUri: categoryFolder + KEEP },
      },
      categoryFolder,
    ],
    [
      "item",
      "/store/inventory/create-item",
      { storeId: STORE, storeItemId: ID, isUpdate: true, storeItem: { ...item(), storeItemImageUris: [itemFolder + KEEP] } },
      itemFolder,
    ],
  ] as const;

  it.each(cases)("%s: a failed update deletes nothing", async (_name, path, body) => {
    ddb.on(UpdateCommand).rejects(conditionFailed());
    const res = await asAdmin(path).send(body);
    expect(res.status).toBe(404);
    expect(s3.calls()).toHaveLength(0);
  });

  it.each(cases)("%s: a successful update then removes unused images", async (_name, path, body, folder) => {
    const order: string[] = [];
    ddb.on(UpdateCommand).callsFake(() => {
      order.push("write");
      return {};
    });
    s3.on(ListObjectsV2Command).callsFake(() => {
      order.push("list");
      return { Contents: [{ Key: `${folder}old.png` }, { Key: folder + KEEP }] };
    });
    s3.on(DeleteObjectsCommand).resolves({});

    const res = await asAdmin(path).send(body);
    expect(res.status).toBe(200);
    expect(order).toEqual(["write", "list"]);
    const deleted = s3.commandCalls(DeleteObjectsCommand)[0].args[0].input.Delete?.Objects?.map((o) => o.Key);
    expect(deleted).toEqual([`${folder}old.png`]);
  });
});
