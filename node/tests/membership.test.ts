import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  addStoreMember,
  getMembership,
  listStoreMembers,
  listUserStores,
  MembershipError,
  removeStoreMember,
} from "../layers/aws/dynamodb/dynamo-entities/membership";

const ddb = mockClient(DynamoDBDocumentClient);
const cancelledAt = (index: number, length: number) =>
  new TransactionCanceledException({
    message: "cancelled",
    $metadata: {},
    CancellationReasons: Array.from({ length }, (_, i) => ({ Code: i === index ? "ConditionalCheckFailed" : "None" })),
  });

beforeEach(() => ddb.reset());

describe("addStoreMember", () => {
  it("writes both rows in one transaction, after checking the store and user exist", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const m = await addStoreMember("S1", "U1", "MERCHANT");
    expect(m).toMatchObject({ storeId: "S1", userId: "U1", role: "MERCHANT" });

    const items = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(items[0].ConditionCheck).toMatchObject({ Key: { pk: "STORE#S1", sk: "SETTINGS" }, ConditionExpression: "attribute_exists(pk)" });
    expect(items[1].ConditionCheck).toMatchObject({ Key: { pk: "USER#U1", sk: "PROFILE#INFO" }, ConditionExpression: "attribute_exists(pk)" });
    expect(items[2].Put).toMatchObject({
      Item: { pk: "STORE#S1", sk: "MEMBER#U1", storeMemberId: "U1", storeMemberPermission: "MERCHANT" },
      ConditionExpression: "attribute_not_exists(pk)",
    });
    expect(items[3].Put!.Item).toMatchObject({ pk: "USER#U1", sk: "STORE#S1", storeId: "S1", storeMemberPermission: "MERCHANT" });
    // No copies of names/slugs that could go stale
    expect(JSON.stringify(items)).not.toMatch(/storeName|storeSlug|userEmail/);
  });

  it.each([
    [0, "STORE_NOT_FOUND"],
    [1, "USER_NOT_FOUND"],
    [2, "ALREADY_MEMBER"],
  ])("maps a failed condition %i to %s", async (index, reason) => {
    ddb.on(TransactWriteCommand).rejects(cancelledAt(index, 4));
    await expect(addStoreMember("S1", "U1", "ADMIN")).rejects.toMatchObject({ name: "MembershipError", reason });
  });

  it("refuses an unknown role without writing", async () => {
    await expect(addStoreMember("S1", "U1", "OWNER" as any)).rejects.toThrow("Unknown store role");
    expect(ddb.calls()).toHaveLength(0);
  });
});

describe("removeStoreMember", () => {
  it("deletes both rows together", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    await removeStoreMember("S1", "U1");
    const items = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(items.map((i) => i.Delete!.Key)).toEqual([
      { pk: "STORE#S1", sk: "MEMBER#U1" },
      { pk: "USER#U1", sk: "STORE#S1" },
    ]);
  });

  it("reports NOT_A_MEMBER", async () => {
    ddb.on(TransactWriteCommand).rejects(cancelledAt(0, 2));
    await expect(removeStoreMember("S1", "U1")).rejects.toBeInstanceOf(MembershipError);
  });
});

describe("getMembership", () => {
  it("reads consistently and returns the role", async () => {
    ddb.on(GetCommand).resolves({ Item: { storeMemberPermission: "ADMIN", storeMemberCreatedAt: 5 } });
    expect(await getMembership("S1", "U1")).toEqual({ storeId: "S1", userId: "U1", role: "ADMIN", createdAt: 5 });
    expect(ddb.commandCalls(GetCommand)[0].args[0].input).toMatchObject({
      Key: { pk: "STORE#S1", sk: "MEMBER#U1" },
      ConsistentRead: true,
    });
  });

  it("returns null when not a member", async () => {
    ddb.on(GetCommand).resolves({});
    expect(await getMembership("S1", "U1")).toBeNull();
  });
});

describe("listing", () => {
  it("listUserStores joins current store names and skips deleted stores", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { storeId: "S2", storeMemberPermission: "MERCHANT" },
        { storeId: "S1", storeMemberPermission: "ADMIN" },
        { storeId: "GONE", storeMemberPermission: "ADMIN" },
      ],
    });
    ddb.on(BatchGetCommand).callsFake((input) => {
      const table = Object.keys(input.RequestItems)[0];
      const names: Record<string, [string, string]> = { S1: ["Alpha", "alpha"], S2: ["Beta", "beta"] };
      const Responses = input.RequestItems[table].Keys.filter((k: any) => !k.sk.includes("GONE")).map((k: any) => {
        const id = k.sk.split("#")[1];
        return { ...k, storeName: names[id][0], storeSlug: names[id][1] };
      });
      return { Responses: { [table]: Responses } };
    });

    expect(await listUserStores("U1")).toEqual([
      { storeId: "S1", storeName: "Alpha", storeSlug: "alpha", role: "ADMIN" },
      { storeId: "S2", storeName: "Beta", storeSlug: "beta", role: "MERCHANT" },
    ]);
    expect(ddb.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues).toEqual({
      ":pk": "USER#U1",
      ":sk_prefix": "STORE#",
    });
  });

  it("listUserStores makes no batch read for a user without stores", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    expect(await listUserStores("U1")).toEqual([]);
    expect(ddb.commandCalls(BatchGetCommand)).toHaveLength(0);
  });

  it("listStoreMembers joins current names and emails, oldest first", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { storeMemberId: "U2", storeMemberPermission: "MERCHANT", storeMemberCreatedAt: 20 },
        { storeMemberId: "U1", storeMemberPermission: "ADMIN", storeMemberCreatedAt: 10 },
      ],
    });
    ddb.on(BatchGetCommand).callsFake((input) => {
      const table = Object.keys(input.RequestItems)[0];
      return {
        Responses: {
          [table]: input.RequestItems[table].Keys.map((k: any) => ({
            ...k,
            userFirstName: k.pk === "USER#U1" ? "Ada" : "Bo",
            userLastName: "",
            userEmailAddress: k.pk === "USER#U1" ? "ada@x.co" : "bo@x.co",
          })),
        },
      };
    });
    const members = await listStoreMembers("S1");
    expect(members.map((m) => [m.userId, m.firstName, m.email, m.role])).toEqual([
      ["U1", "Ada", "ada@x.co", "ADMIN"],
      ["U2", "Bo", "bo@x.co", "MERCHANT"],
    ]);
  });
});
