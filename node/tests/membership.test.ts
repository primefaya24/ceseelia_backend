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
  cancelStoreInvite,
  claimStoreInvites,
  inviteStoreMember,
  listStoreInvites,
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

/* Query answers by partition: the user's USER#/STORE# rows and an email's INVITE# rows. */
function partitions(rows: Record<string, object[]>) {
  ddb.on(QueryCommand).callsFake((input) => ({ Items: rows[input.ExpressionAttributeValues[":pk"]] ?? [] }));
}

beforeEach(() => {
  ddb.reset();
  ddb.on(QueryCommand).resolves({ Items: [] });
});

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

  it("one store per account (P.11): refuses a user who belongs to another store, without writing", async () => {
    partitions({ "USER#U1": [{ storeId: "S2", storeMemberPermission: "MERCHANT" }] });
    await expect(addStoreMember("S1", "U1", "MERCHANT")).rejects.toMatchObject({ reason: "ALREADY_IN_A_STORE" });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("a member of this same store still gets ALREADY_MEMBER from the transaction", async () => {
    partitions({ "USER#U1": [{ storeId: "S1", storeMemberPermission: "MERCHANT" }] });
    ddb.on(TransactWriteCommand).rejects(cancelledAt(2, 4));
    await expect(addStoreMember("S1", "U1", "ADMIN")).rejects.toMatchObject({ reason: "ALREADY_MEMBER" });
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

describe("invites (1.4)", () => {
  it("inviteStoreMember writes both rows with a normalized email, after checking the store", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const invite = await inviteStoreMember("S1", "  New@Example.COM ", "MERCHANT");
    expect(invite).toMatchObject({ email: "new@example.com", role: "MERCHANT" });
    const items = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
    expect(items[0].ConditionCheck!.Key).toEqual({ pk: "STORE#S1", sk: "SETTINGS" });
    expect(items[1].Put!.Item).toMatchObject({ pk: "STORE#S1", sk: "INVITE#new@example.com", storeInviteEmail: "new@example.com" });
    expect(items[2].Put!.Item).toMatchObject({ pk: "INVITE#new@example.com", sk: "STORE#S1", storeId: "S1" });
    // Re-inviting replaces the invite instead of failing
    expect(items[1].Put!.ConditionExpression).toBeUndefined();
  });

  it("inviteStoreMember refuses an email invited to another store (P.11); re-inviting to the same store is fine", async () => {
    partitions({ "INVITE#a@b.co": [{ storeId: "S2" }] });
    ddb.on(TransactWriteCommand).resolves({});
    await expect(inviteStoreMember("S1", "A@b.co", "MERCHANT")).rejects.toMatchObject({ reason: "ALREADY_IN_A_STORE" });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    await inviteStoreMember("S2", "a@b.co", "ADMIN");
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it("inviteStoreMember reports a missing store", async () => {
    ddb.on(TransactWriteCommand).rejects(cancelledAt(0, 3));
    await expect(inviteStoreMember("S1", "a@b.co", "ADMIN")).rejects.toMatchObject({ reason: "STORE_NOT_FOUND" });
  });

  it("cancelStoreInvite deletes both rows, or reports NOT_INVITED", async () => {
    ddb.on(TransactWriteCommand).resolvesOnce({}).rejectsOnce(cancelledAt(0, 2));
    await cancelStoreInvite("S1", "A@B.co");
    const keys = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!.map((i) => i.Delete!.Key);
    expect(keys).toEqual([
      { pk: "STORE#S1", sk: "INVITE#a@b.co" },
      { pk: "INVITE#a@b.co", sk: "STORE#S1" },
    ]);
    await expect(cancelStoreInvite("S1", "a@b.co")).rejects.toMatchObject({ reason: "NOT_INVITED" });
  });

  it("listStoreInvites returns email and role, oldest first", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { storeInviteEmail: "b@x.co", storeMemberPermission: "MERCHANT", storeInviteCreatedAt: 2 },
        { storeInviteEmail: "a@x.co", storeMemberPermission: "ADMIN", storeInviteCreatedAt: 1 },
      ],
    });
    expect(await listStoreInvites("S1")).toEqual([
      { email: "a@x.co", role: "ADMIN", createdAt: 1 },
      { email: "b@x.co", role: "MERCHANT", createdAt: 2 },
    ]);
    expect(ddb.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues).toEqual({ ":pk": "STORE#S1", ":sk_prefix": "INVITE#" });
  });

  describe("claimStoreInvites", () => {
    const invites = (storeIds: string[], userStores: string[] = []) =>
      partitions({
        "INVITE#a@b.co": storeIds.map((storeId) => ({ storeId, storeMemberPermission: "MERCHANT" })),
        "USER#U1": userStores.map((storeId) => ({ storeId, storeMemberPermission: "MERCHANT" })),
      });

    it("turns an invite into a membership in one transaction", async () => {
      invites(["S1"]);
      ddb.on(TransactWriteCommand).resolves({});
      expect(await claimStoreInvites("U1", " A@B.co ")).toEqual(["S1"]);
      expect(ddb.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues).toEqual({ ":pk": "INVITE#a@b.co" });
      const items = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
      expect(items[0].ConditionCheck!.Key).toEqual({ pk: "STORE#S1", sk: "SETTINGS" });
      expect(items[1].Delete).toMatchObject({ Key: { pk: "STORE#S1", sk: "INVITE#a@b.co" }, ConditionExpression: "attribute_exists(pk)" });
      expect(items[2].Delete!.Key).toEqual({ pk: "INVITE#a@b.co", sk: "STORE#S1" });
      expect(items[3].Put).toMatchObject({ Item: { pk: "STORE#S1", sk: "MEMBER#U1", storeMemberPermission: "MERCHANT" }, ConditionExpression: "attribute_not_exists(pk)" });
      expect(items[4].Put!.Item).toMatchObject({ pk: "USER#U1", sk: "STORE#S1" });
    });

    it("one store per account (P.11): claims the first invite and removes the others", async () => {
      invites(["S1", "S2"]);
      ddb.on(TransactWriteCommand).resolves({});
      expect(await claimStoreInvites("U1", "a@b.co")).toEqual(["S1"]);
      const second = ddb.commandCalls(TransactWriteCommand)[1].args[0].input.TransactItems!;
      expect(second.map((i) => i.Delete!.Key)).toEqual([
        { pk: "STORE#S2", sk: "INVITE#a@b.co" },
        { pk: "INVITE#a@b.co", sk: "STORE#S2" },
      ]);
    });

    it("a user who already has a store claims nothing; the invites are removed", async () => {
      invites(["S1"], ["S9"]);
      ddb.on(TransactWriteCommand).resolves({});
      expect(await claimStoreInvites("U1", "a@b.co")).toEqual([]);
      const only = ddb.commandCalls(TransactWriteCommand);
      expect(only).toHaveLength(1);
      expect(only[0].args[0].input.TransactItems!.every((i) => i.Delete)).toBe(true);
    });

    it("no invites: no store lookup", async () => {
      invites([]);
      expect(await claimStoreInvites("U1", "a@b.co")).toEqual([]);
      expect(ddb.commandCalls(QueryCommand)).toHaveLength(1);
    });

    it.each([
      [0, "the store is gone"],
      [3, "the user is already a member"],
    ])("just removes the invite when condition %i fails (%s)", async (index) => {
      invites(["S1"]);
      ddb.on(TransactWriteCommand).rejectsOnce(cancelledAt(index, 5)).resolves({});
      expect(await claimStoreInvites("U1", "a@b.co")).toEqual([]);
      const cleanup = ddb.commandCalls(TransactWriteCommand)[1].args[0].input.TransactItems!;
      expect(cleanup.map((i) => i.Delete!.Key)).toEqual([
        { pk: "STORE#S1", sk: "INVITE#a@b.co" },
        { pk: "INVITE#a@b.co", sk: "STORE#S1" },
      ]);
    });

    it("skips an invite another request claimed first", async () => {
      invites(["S1"]);
      ddb.on(TransactWriteCommand).rejects(cancelledAt(1, 5));
      expect(await claimStoreInvites("U1", "a@b.co")).toEqual([]);
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
    });

    it("rethrows other errors", async () => {
      invites(["S1"]);
      ddb.on(TransactWriteCommand).rejects(new Error("throttled"));
      await expect(claimStoreInvites("U1", "a@b.co")).rejects.toThrow("throttled");
    });

    it("does nothing without an email", async () => {
      expect(await claimStoreInvites("U1", "")).toEqual([]);
      expect(ddb.calls()).toHaveLength(0);
    });
  });
});

