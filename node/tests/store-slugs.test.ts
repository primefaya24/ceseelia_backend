import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { isValidSlug } from "../constants/slug";
import { updateStoreInfo } from "../layers/aws/dynamodb/dynamo-entities/admin";
import { deleteStore, StoreRecordNotFoundError } from "../layers/aws/dynamodb/dynamo-entities/store";
import { SlugTakenError } from "../layers/aws/dynamodb/dynamo-entities/slug";
import { createApp } from "../app";

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);
const app = createApp();
const STORE = "01JBZ0000000000000000000AA";
const OTHER = "01JBZ0000000000000000000BB";
const OVERVIEW_KEY = { pk: "APP_STORE", sk: `STORE#${STORE}#OVERVIEW` };

const cancelled = (codes: string[]) =>
  Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
const conditionFailed = () =>
  Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });

/* GetCommand answers: the store's overview row, and who holds each slug. */
function world({ slug = "old-name", owners = {} as Record<string, string> } = {}) {
  ddb.on(GetCommand).callsFake((input) => {
    if (input.Key.pk === "APP_STORE") {
      return { Item: { ...OVERVIEW_KEY, storeId: STORE, storeName: "Old", storeSlug: slug, storeOrderLastCompletedTimestamp: 0 } };
    }
    const owner = owners[input.Key.pk.replace(/^SLUG#/, "")];
    return owner ? { Item: { ...input.Key, storeId: owner } } : {};
  });
}
const transactItems = (i = 0) => ddb.commandCalls(TransactWriteCommand)[i].args[0].input.TransactItems!;

function call(method: "get" | "post", path: string, body?: object, admin = true) {
  verifyMockAs(admin);
  const r = request(app)[method](`/api/v1${path}`).set("Host", "localhost").set("Authorization", "Bearer good");
  return body ? r.send(body) : r;
}
function verifyMockAs(admin: boolean) {
  vi.mocked(verifyCognitoAccessToken).mockResolvedValue({
    sub: "sub-1",
    "cognito:groups": admin ? ["Admins"] : [],
  });
}

beforeEach(() => {
  ddb.reset();
  s3.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("slug format (1.8a)", () => {
  it.each(["abc", "northern-hoop", "shop-24", "a1b", "x".repeat(40)])("accepts %s", (s) => {
    expect(isValidSlug(s)).toBe(true);
  });
  it.each([
    "ab", // too short
    "x".repeat(41), // too long
    "Northern-Hoop", // uppercase
    "-shop", "shop-", "my--shop", // hyphen placement
    "my shop", "my_shop", "café", "shop.com", "shop/1", // characters
    "admin", "api", "www", "storefront", "checkout", // reserved
    "",
  ])("rejects %j", (s) => {
    expect(isValidSlug(s)).toBe(false);
  });
  it("rejects non-strings", () => {
    expect(isValidSlug(undefined)).toBe(false);
    expect(isValidSlug(123)).toBe(false);
  });
});

describe("create / update-store-info validate the slug (1.8a)", () => {
  it.each([
    ["post", "/store/create", { storeName: "Shop", storeSlug: "Bad Slug" }],
    ["post", "/admin/update-store-info", { storeId: STORE, storeName: "Shop", storeSlug: "admin" }],
    ["post", "/store/create", { storeName: "   ", storeSlug: "shop" }],
  ] as const)("%s %s → 400 before touching the table", async (method, path, body) => {
    const res = await call(method, path, body);
    expect(res.status).toBe(400);
    expect(ddb.calls()).toHaveLength(0);
  });
});

describe("create reserves the slug (1.8b)", () => {
  it("returns 409 with a message when another store holds the slug", async () => {
    ddb.on(TransactWriteCommand).rejects(cancelled(["None", "None", "ConditionalCheckFailed"]));
    const res = await call("post", "/store/create", { storeName: "Shop", storeSlug: "shop" });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe("That slug is already taken.");
  });

  it("other transaction failures are still 500", async () => {
    ddb.on(TransactWriteCommand).rejects(cancelled(["ConditionalCheckFailed", "None", "None"]));
    expect((await call("post", "/store/create", { storeName: "Shop", storeSlug: "shop" })).status).toBe(500);
  });
});

describe("updateStoreInfo moves the reservation (1.8b)", () => {
  it("reserves the new slug and releases the old one when it's ours", async () => {
    world({ owners: { "old-name": STORE } });
    ddb.on(TransactWriteCommand).resolves({});
    const result = await updateStoreInfo(STORE, "New", "new-name");

    expect(result).toMatchObject({ storeId: STORE, storeName: "New", storeSlug: "new-name" });
    const items = transactItems();
    expect(items).toHaveLength(3);
    expect(items[0].Update!.Key).toEqual(OVERVIEW_KEY);
    expect(items[0].Update!.ExpressionAttributeValues![":oldSlug"]).toBe("old-name");
    expect(items[1].Put!.Item).toMatchObject({ pk: "SLUG#new-name", sk: "STORE", storeId: STORE });
    expect(items[1].Put!.ConditionExpression).toBe("attribute_not_exists(pk) OR storeId = :storeId");
    expect(items[2].Delete!.Key).toEqual({ pk: "SLUG#old-name", sk: "STORE" });
    expect(items[2].Delete!.ConditionExpression).toBe("storeId = :storeId");
  });

  it("same slug (name-only change): re-reserves it, releases nothing", async () => {
    world({ owners: { "old-name": STORE } });
    ddb.on(TransactWriteCommand).resolves({});
    await updateStoreInfo(STORE, "Renamed", "old-name");
    expect(transactItems().map((t) => Object.keys(t)[0])).toEqual(["Update", "Put"]);
  });

  it("doesn't release an old slug that another store holds (or nobody does)", async () => {
    world({ owners: { "old-name": OTHER } });
    ddb.on(TransactWriteCommand).resolves({});
    await updateStoreInfo(STORE, "New", "new-name");
    expect(transactItems()).toHaveLength(2);

    ddb.reset();
    world({ owners: {} });
    ddb.on(TransactWriteCommand).resolves({});
    await updateStoreInfo(STORE, "New", "new-name");
    expect(transactItems()).toHaveLength(2);
  });

  it("throws SlugTakenError when the new slug is held by another store", async () => {
    world({ owners: { "old-name": STORE } });
    ddb.on(TransactWriteCommand).rejects(cancelled(["None", "ConditionalCheckFailed", "None"]));
    await expect(updateStoreInfo(STORE, "New", "taken")).rejects.toBeInstanceOf(SlugTakenError);
  });

  it("retries when the store's slug changed between the read and the write", async () => {
    world({ owners: { "old-name": STORE } });
    ddb
      .on(TransactWriteCommand)
      .rejectsOnce(cancelled(["ConditionalCheckFailed", "None", "None"]))
      .resolves({});
    await updateStoreInfo(STORE, "New", "new-name");
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(2);
  });

  it("gives up after 3 tries", async () => {
    world({ owners: { "old-name": STORE } });
    ddb.on(TransactWriteCommand).rejects(cancelled(["ConditionalCheckFailed", "None", "None"]));
    await expect(updateStoreInfo(STORE, "New", "new-name")).rejects.toThrow(/gave up/);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(3);
  });

  it("throws StoreRecordNotFoundError when the store doesn't exist", async () => {
    ddb.on(GetCommand).resolves({});
    await expect(updateStoreInfo(STORE, "New", "new-name")).rejects.toBeInstanceOf(StoreRecordNotFoundError);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("route maps them to 409 / 404 / 200", async () => {
    const body = { storeId: STORE, storeName: "New", storeSlug: "new-name" };
    world({ owners: { "old-name": STORE } });
    ddb.on(TransactWriteCommand).rejects(cancelled(["None", "ConditionalCheckFailed", "None"]));
    const taken = await call("post", "/admin/update-store-info", body);
    expect(taken.status).toBe(409);
    expect(taken.body.message).toBe("That slug is already taken.");

    ddb.reset();
    ddb.on(GetCommand).resolves({});
    expect((await call("post", "/admin/update-store-info", body)).status).toBe(404);

    ddb.reset();
    world({ owners: { "old-name": STORE } });
    ddb.on(TransactWriteCommand).resolves({});
    const ok = await call("post", "/admin/update-store-info", body);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ storeId: STORE, storeName: "New", storeSlug: "new-name" });
  });

  it("is admin-only", async () => {
    const res = await call("post", "/admin/update-store-info", { storeId: STORE, storeName: "N", storeSlug: "new-name" }, false);
    expect(res.status).toBe(403);
  });
});

describe("deleteStore frees the slug (1.8b / 1.7b)", () => {
  function storeRows() {
    ddb.on(QueryCommand).resolves({ Items: [{ pk: `STORE#${STORE}`, sk: "SETTINGS" }] });
    ddb.on(GetCommand).resolves({ Item: { ...OVERVIEW_KEY, storeSlug: "old-name" } });
    ddb.on(BatchWriteCommand).resolves({});
    s3.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });
  }

  it("deletes SLUG#<slug> (only while ours) just before the overview row", async () => {
    storeRows();
    ddb.on(DeleteCommand).resolves({});
    await deleteStore(STORE);
    const deletes = ddb.commandCalls(DeleteCommand).map((c) => c.args[0].input);
    expect(deletes.map((d) => d.Key)).toEqual([
      { pk: `STORE#${STORE}`, sk: "SETTINGS" },
      { pk: "SLUG#old-name", sk: "STORE" },
      OVERVIEW_KEY,
    ]);
    expect(deletes[1].ConditionExpression).toBe("storeId = :storeId");
    expect(deletes[1].ExpressionAttributeValues).toEqual({ ":storeId": STORE });
  });

  it("carries on when the slug isn't ours or is already gone", async () => {
    storeRows();
    ddb.on(DeleteCommand).resolves({});
    ddb.on(DeleteCommand, { Key: { pk: "SLUG#old-name", sk: "STORE" } }).rejects(conditionFailed());
    expect(await deleteStore(STORE)).toBe(true);
    expect(ddb.commandCalls(DeleteCommand).at(-1)!.args[0].input.Key).toEqual(OVERVIEW_KEY);
  });

  it("stops (keeping the overview for a retry) on any other error", async () => {
    storeRows();
    ddb.on(DeleteCommand).resolves({});
    ddb.on(DeleteCommand, { Key: { pk: "SLUG#old-name", sk: "STORE" } }).rejects(new Error("throttled"));
    await expect(deleteStore(STORE)).rejects.toThrow("throttled");
    expect(ddb.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key)).not.toContainEqual(OVERVIEW_KEY);
  });
});

describe("GET /store/public/resolve-slug/:slug (1.8c)", () => {
  const resolve = (slug: string) =>
    request(app).get(`/api/v1/store/public/resolve-slug/${slug}`).set("Host", "localhost");

  it("returns the store id, without sign-in", async () => {
    world({ owners: { "northern-hoop": STORE } });
    const res = await resolve("northern-hoop");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ storeId: STORE });
  });

  it("lowercases the slug first", async () => {
    world({ owners: { "northern-hoop": STORE } });
    expect((await resolve("Northern-Hoop")).body).toEqual({ storeId: STORE });
    expect(ddb.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({ pk: "SLUG#northern-hoop", sk: "STORE" });
  });

  it("404 when no store holds it", async () => {
    world();
    expect((await resolve("nobody-here")).status).toBe(404);
  });

  it("400 for a malformed or reserved slug, without a DB read", async () => {
    expect((await resolve("a_b")).status).toBe(400);
    expect((await resolve("admin")).status).toBe(400);
    expect(ddb.calls()).toHaveLength(0);
  });

  it("500 when the read fails", async () => {
    ddb.on(GetCommand).rejects(new Error("boom"));
    expect((await resolve("northern-hoop")).status).toBe(500);
  });
});
