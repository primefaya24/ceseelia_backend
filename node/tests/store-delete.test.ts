import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { deleteStore } from "../layers/aws/dynamodb/dynamo-entities/store";
import { deleteS3Files } from "../layers/aws/s3";
import { createApp } from "../app";

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);
const STORE = "01JBZ0000000000000000000AA";
const PK = `STORE#${STORE}`;
const OVERVIEW = { pk: "APP_STORE", sk: `STORE#${STORE}#OVERVIEW` };

function storeWith(rows: Array<{ sk: string }>, { overview = true, files = [] as string[] } = {}) {
  ddb.on(QueryCommand).resolves({ Items: rows.map((r) => ({ pk: PK, ...r })) });
  ddb.on(GetCommand).resolves(overview ? { Item: { ...OVERVIEW, storeName: "X" } } : {});
  ddb.on(DeleteCommand).resolves({});
  ddb.on(BatchWriteCommand).resolves({});
  s3.on(ListObjectsV2Command).resolves({ Contents: files.map((Key) => ({ Key })), IsTruncated: false });
  s3.on(DeleteObjectsCommand).resolves({});
}
const batchDeletedKeys = () =>
  ddb.commandCalls(BatchWriteCommand).flatMap((c) =>
    Object.values(c.args[0].input.RequestItems!).flat().map((w: any) => w.DeleteRequest.Key)
  );
const deletedKeys = () => ddb.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key);

beforeEach(() => {
  ddb.reset();
  s3.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("deleteStore (1.7)", () => {
  it("deletes settings first, then the partition and the rows pointing at it, files, and the overview last", async () => {
    storeWith(
      [
        { sk: "SETTINGS" },
        { sk: "CATEGORY#C1" },
        { sk: "ITEM#I1" },
        { sk: "MEMBER#U1" },
        { sk: "INVITE#new@x.co" },
      ],
      { files: [`store/${STORE}/images/logo/a.png`, `store/${STORE}/item/I1/images/b.jpg`] }
    );
    expect(await deleteStore(STORE)).toBe(true);

    expect(deletedKeys()).toEqual([{ pk: PK, sk: "SETTINGS" }, OVERVIEW]);
    expect(batchDeletedKeys()).toEqual([
      { pk: PK, sk: "CATEGORY#C1" },
      { pk: PK, sk: "ITEM#I1" },
      { pk: PK, sk: "MEMBER#U1" },
      { pk: "USER#U1", sk: `STORE#${STORE}` },
      { pk: PK, sk: "INVITE#new@x.co" },
      { pk: "INVITE#new@x.co", sk: `STORE#${STORE}` },
    ]);
    expect(s3.commandCalls(ListObjectsV2Command)[0].args[0].input.Prefix).toBe(`store/${STORE}/`);
    expect(s3.commandCalls(DeleteObjectsCommand)[0].args[0].input.Delete!.Objects).toHaveLength(2);

    // Order: SETTINGS delete before the batch, overview delete after S3
    const order = ddb.calls().map((c) => c.args[0].constructor.name);
    expect(order.indexOf("DeleteCommand")).toBeLessThan(order.indexOf("BatchWriteCommand"));
    expect(order.lastIndexOf("DeleteCommand")).toBe(order.length - 1);
  });

  it("returns false when there's nothing left, without deleting anything", async () => {
    storeWith([], { overview: false });
    expect(await deleteStore(STORE)).toBe(false);
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(0);
    expect(s3.calls()).toHaveLength(0);
  });

  it("finishes a half-done delete (only the overview left)", async () => {
    storeWith([]);
    expect(await deleteStore(STORE)).toBe(true);
    expect(deletedKeys()).toEqual([OVERVIEW]);
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it("keeps the overview when deleting files fails, so it can be retried", async () => {
    storeWith([{ sk: "SETTINGS" }], { files: ["store/x/a.png"] });
    s3.on(DeleteObjectsCommand).resolves({ Errors: [{ Key: "store/x/a.png", Code: "AccessDenied" }] });
    await expect(deleteStore(STORE)).rejects.toThrow("AccessDenied");
    expect(deletedKeys()).not.toContainEqual(OVERVIEW);
  });
});

describe("deleteS3Files", () => {
  it("sends at most 1000 keys per request", async () => {
    s3.on(DeleteObjectsCommand).resolves({});
    await deleteS3Files("b", Array.from({ length: 2500 }, (_, i) => ({ Key: `k${i}` })));
    expect(s3.commandCalls(DeleteObjectsCommand).map((c) => c.args[0].input.Delete!.Objects!.length)).toEqual([1000, 1000, 500]);
  });
});

describe("DELETE /store/delete/:storeId", () => {
  const app = createApp();
  const del = (id = STORE) =>
    request(app).delete(`/api/v1/store/delete/${id}`).set("Host", "localhost").set("Authorization", "Bearer t");

  it("deletes for an admin", async () => {
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "a", "cognito:groups": ["Admins"] });
    storeWith([{ sk: "SETTINGS" }]);
    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
  });

  it("404 when the store is already gone", async () => {
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "a", "cognito:groups": ["Admins"] });
    storeWith([], { overview: false });
    const res = await del();
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("STORE_NOT_FOUND");
  });

  it("is admin-only and touches nothing otherwise", async () => {
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "m", "cognito:groups": [] });
    expect((await del()).status).toBe(403);
    expect(ddb.calls()).toHaveLength(0);
  });

  it("500 when a step fails", async () => {
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "a", "cognito:groups": ["Admins"] });
    storeWith([{ sk: "SETTINGS" }]);
    ddb.on(DeleteCommand).rejects(new Error("down"));
    expect((await del()).status).toBe(500);
  });
});
