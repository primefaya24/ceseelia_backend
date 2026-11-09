import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { BatchGetCommand, BatchWriteCommand, DynamoDBDocumentClient, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

vi.mock("../layers/aws/cognito", () => ({
  verifyCognitoAccessToken: vi.fn(),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";
import {
  batchRetry,
  DynamoBatchError,
  dynamGetManyItems,
  dynamoWriteBatch,
  dynamoWriteManyItems,
} from "../layers/aws/dynamodb/dynamo-batch-ops";
import { createStore } from "../layers/aws/dynamodb/dynamo-entities/store";

const ddb = mockClient(DynamoDBDocumentClient);
const T = "table";
const put = (n: number) => ({ PutRequest: { Item: { pk: "P", sk: `S${n}` } } });
const puts = (count: number) => Array.from({ length: count }, (_, i) => put(i));
const key = (n: number) => ({ pk: "P", sk: `S${n}` });

const saved = { ...batchRetry };
beforeEach(() => {
  ddb.reset();
  batchRetry.baseDelayMs = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => Object.assign(batchRetry, saved));

const writeSizes = () =>
  ddb.commandCalls(BatchWriteCommand).map((c) => c.args[0].input.RequestItems![T].length);

describe("batch writes", () => {
  it("writes a batch in one call when everything is processed", async () => {
    ddb.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await dynamoWriteBatch(T, puts(3));
    expect(writeSizes()).toEqual([3]);
  });

  it("retries only the unprocessed items", async () => {
    ddb
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { [T]: [put(2)] } })
      .resolves({ UnprocessedItems: {} });
    await dynamoWriteBatch(T, puts(3));
    expect(writeSizes()).toEqual([3, 1]);
    expect(ddb.commandCalls(BatchWriteCommand)[1].args[0].input.RequestItems![T]).toEqual([put(2)]);
  });

  it("throws when items are still unprocessed after the last attempt", async () => {
    ddb.on(BatchWriteCommand).resolves({ UnprocessedItems: { [T]: [put(0)] } });
    await expect(dynamoWriteBatch(T, puts(1))).rejects.toThrow(DynamoBatchError);
    expect(writeSizes()).toHaveLength(batchRetry.maxAttempts);
  });

  it("throws when DynamoDB rejects the request", async () => {
    ddb.on(BatchWriteCommand).rejects(new Error("boom"));
    await expect(dynamoWriteBatch(T, puts(1))).rejects.toThrow(DynamoBatchError);
  });

  it("splits large writes into batches of 25 and doesn't change the input", async () => {
    ddb.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    const items = puts(60);
    const copy = structuredClone(items);
    await dynamoWriteManyItems(T, items);
    expect(writeSizes()).toEqual([25, 25, 10]);
    expect(items).toEqual(copy);
  });

  it("dynamoWriteManyItems throws if any batch fails", async () => {
    let call = 0;
    ddb.on(BatchWriteCommand).callsFake(() => {
      if (++call === 2) throw new Error("boom");
      return { UnprocessedItems: {} };
    });
    await expect(dynamoWriteManyItems(T, puts(60))).rejects.toThrow("1 of 3 write batch(es) failed");
  });

  it("refuses a missing table name", async () => {
    await expect(dynamoWriteManyItems(undefined, puts(1))).rejects.toThrow("No table name");
    expect(ddb.calls()).toHaveLength(0);
  });
});

describe("batch gets", () => {
  it("returns items from every batch, not just the first", async () => {
    ddb.on(BatchGetCommand).callsFake((input) => ({
      Responses: { [T]: input.RequestItems[T].Keys.map((k: object) => ({ ...k, found: true })) },
    }));
    const items = await dynamGetManyItems(T, Array.from({ length: 150 }, (_, i) => key(i)));
    expect(ddb.commandCalls(BatchGetCommand).map((c) => c.args[0].input.RequestItems![T].Keys!.length)).toEqual([
      100, 50,
    ]);
    expect(items).toHaveLength(150);
  });

  it("retries unprocessed keys and keeps the items already returned", async () => {
    ddb
      .on(BatchGetCommand)
      .resolvesOnce({ Responses: { [T]: [key(0)] }, UnprocessedKeys: { [T]: { Keys: [key(1)] } } })
      .resolves({ Responses: { [T]: [key(1)] } });
    expect(await dynamGetManyItems(T, [key(0), key(1)])).toEqual([key(0), key(1)]);
  });

  it("throws when keys stay unprocessed", async () => {
    ddb.on(BatchGetCommand).resolves({ Responses: { [T]: [] }, UnprocessedKeys: { [T]: { Keys: [key(0)] } } });
    await expect(dynamGetManyItems(T, [key(0)])).rejects.toThrow(DynamoBatchError);
  });
});

describe("callers no longer report false success", () => {
  it("createStore rejects when its write fails", async () => {
    // createStore writes in one transaction since 1.8 (no batch to half-apply).
    ddb.on(TransactWriteCommand).rejects(new Error("boom"));
    await expect(createStore("Shop", "shop")).rejects.toThrow("boom");
  });

  it("POST /store/create returns 500 instead of a store that wasn't saved", async () => {
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "admin-1", "cognito:groups": ["Admins"] });
    ddb.on(TransactWriteCommand).rejects(new Error("boom"));
    const res = await request(createApp())
      .post("/api/v1/store/create")
      .set("Host", "localhost")
      .set("Authorization", "Bearer good")
      .send({ storeName: "Shop", storeSlug: "shop" });
    expect(res.status).toBe(500);
  });
});
