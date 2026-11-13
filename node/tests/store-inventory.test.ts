import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getStoreInventoryData } from "../layers/aws/dynamodb/dynamo-entities/store";

const ddb = mockClient(DynamoDBDocumentClient);

// Fake a table where each query returns `pageSize` rows per page, like DynamoDB's 1 MB cut-off.
function pagedRows(prefix: string, total: number, pageSize: number) {
  const rows = Array.from({ length: total }, (_, i) => ({ pk: "STORE#S1", sk: `${prefix}${i}`, n: i }));
  return (input: any) => {
    const start = input.ExclusiveStartKey ? rows.findIndex((r) => r.sk === input.ExclusiveStartKey.sk) + 1 : 0;
    const page = rows.slice(start, start + pageSize);
    const last = page[page.length - 1];
    return {
      Items: page,
      LastEvaluatedKey: start + pageSize < rows.length ? { pk: last.pk, sk: last.sk } : undefined,
    };
  };
}

beforeEach(() => {
  ddb.reset();
  ddb.on(GetCommand).resolves({ Item: { pk: "STORE#S1", sk: "SETTINGS", templateId: "t0" } });
});

describe("getStoreInventoryData", () => {
  it("follows every page of categories and items", async () => {
    const categories = pagedRows("CATEGORY#", 5, 2);
    const items = pagedRows("ITEM#", 7, 3);
    ddb.on(QueryCommand).callsFake((input) =>
      input.ExpressionAttributeValues[":sk_prefix"] === "CATEGORY#" ? categories(input) : items(input)
    );

    const data = await getStoreInventoryData("S1");

    expect(data.categories.map((c: any) => c.n)).toEqual([0, 1, 2, 3, 4]);
    expect(data.items.map((i: any) => i.n)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(3 + 3); // ceil(5/2) + ceil(7/3)
    expect(data.items[0]).not.toHaveProperty("pk");
    expect(data.settings).toEqual({
      templateId: "t0",
      admin: { commissionMode: "FIXED", commissionPercentBps: 0, salesCommissions: { USD: 125, CAD: 125, AUD: 125 }, suspended: false }, // defaults filled in (5.1a)
      lifecycle: { status: "LIVE", plan: "FREE" }, // no lifecycle saved: live on FREE (P.2, A2)
    });
  });

  it("makes one query per type for a small store", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    const data = await getStoreInventoryData("S1");
    expect(data.categories).toEqual([]);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(2);
  });
});
