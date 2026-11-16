import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  ensureStorePrefix,
  formatOrderCode,
  nextOrderCode,
  orderCodeCounterKey,
  prefixCandidates,
} from "../layers/aws/dynamodb/dynamo-entities/order-code";

const ddb = mockClient(DynamoDBDocumentClient);
const STORE = "01KTESTSTORE0000000000000A";

const cancelled = (codes: Array<string | undefined>) =>
  Object.assign(new Error("cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code: Code ?? "None" })),
  });

describe("prefixCandidates", () => {
  it("starts with the first two words' initials, then the first word's letters", () => {
    const c = prefixCandidates("Pressed By PMerch 1");
    expect(c[0]).toBe("PB");
    expect(c[1]).toBe("PR");
    expect(c).toContain("PBP");
  });

  it("is capital letters only, 2 to 4 long, no repeats", () => {
    const c = prefixCandidates("Café Ö'Neil & Sons — 24/7");
    expect(c[0]).toBe("CO");
    for (const p of c) expect(p).toMatch(/^[A-Z]{2,4}$/);
    expect(new Set(c).size).toBe(c.length);
  });

  it("one-word names still give pairs; names with no letters give none", () => {
    expect(prefixCandidates("Northern")[0]).toBe("NO");
    expect(prefixCandidates("123 456")).toEqual([]);
    expect(prefixCandidates("")).toEqual([]);
  });
});

describe("order codes", () => {
  beforeEach(() => ddb.reset());

  it("formats as prefix-number", () => {
    expect(formatOrderCode("PB", 1001)).toBe("PB-1001");
  });

  it("uses the store's prefix and the next number", async () => {
    ddb.on(GetCommand).resolves({ Item: { ...orderCodeCounterKey(STORE), prefix: "PB", n: 1004 } });
    ddb.on(UpdateCommand).resolves({ Attributes: { n: 1005 } });
    expect(await nextOrderCode(STORE, "Pressed By PMerch 1")).toBe("PB-1005");
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    const update = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.UpdateExpression).toBe("ADD n :one");
    expect(update.Key).toEqual(orderCodeCounterKey(STORE));
  });

  it("reserves a prefix on the first order; its number is 1001", async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(TransactWriteCommand).resolves({});
    ddb.on(UpdateCommand).resolves({ Attributes: { n: 1001 } });
    expect(await nextOrderCode(STORE, "Pressed By PMerch 1")).toBe("PB-1001");
    const tx = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(tx[0].Put!.Item).toMatchObject({ pk: "ORDER_CODE_PREFIX#PB", sk: "STORE", storeId: STORE });
    expect(tx[0].Put!.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(tx[1].Put!.Item).toMatchObject({ ...orderCodeCounterKey(STORE), prefix: "PB", n: 1000 });
  });

  it("skips prefixes other stores hold", async () => {
    ddb.on(GetCommand).resolves({});
    ddb
      .on(TransactWriteCommand)
      .rejectsOnce(cancelled(["ConditionalCheckFailed", undefined]))
      .rejectsOnce(cancelled(["ConditionalCheckFailed", undefined]))
      .resolves({});
    expect(await ensureStorePrefix(STORE, "Pressed By PMerch 1")).toBe(prefixCandidates("Pressed By PMerch 1")[2]);
  });

  it("uses the prefix another request reserved for the same store at the same time", async () => {
    ddb.on(GetCommand).resolvesOnce({}).resolves({ Item: { prefix: "PB", n: 1000 } });
    ddb.on(TransactWriteCommand).rejects(cancelled([undefined, "ConditionalCheckFailed"]));
    expect(await ensureStorePrefix(STORE, "Pressed By PMerch 1")).toBe("PB");
  });

  it("falls back to random letters when the name has none", async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(TransactWriteCommand).resolves({});
    expect(await ensureStorePrefix(STORE, "123")).toMatch(/^[A-Z]{3}$/);
  });

  it("fails rather than reuse a number", async () => {
    ddb.on(GetCommand).resolves({ Item: { prefix: "PB", n: 1000 } });
    ddb.on(UpdateCommand).resolves({ Attributes: {} });
    await expect(nextOrderCode(STORE, "x")).rejects.toThrow();
  });

  it("passes on other DynamoDB errors", async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(TransactWriteCommand).rejects(new Error("throttled"));
    await expect(ensureStorePrefix(STORE, "Pressed By")).rejects.toThrow("throttled");
  });
});
