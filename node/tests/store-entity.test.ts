import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createStore, updateStoreSettings } from "../layers/aws/dynamodb/dynamo-entities/store";
import { initStoreSettings } from "../layers/core/interfaces/store";

const ddb = mockClient(DynamoDBDocumentClient);
beforeEach(() => {
  ddb.reset();
  ddb.on(TransactWriteCommand).resolves({});
  ddb.on(UpdateCommand).resolves({});
});

describe("store entity", () => {
  it("createStore writes the overview, default settings and slug reservation in one transaction", async () => {
    const overview = await createStore("Candly", "candly");
    expect(overview.storeName).toBe("Candly");
    expect(overview.storeId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const calls = ddb.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    const puts = calls[0].args[0].input.TransactItems!.map((t: any) => t.Put);
    expect(puts.map((p: any) => `${p.Item.pk}|${p.Item.sk}`)).toEqual([
      `APP_STORE|STORE#${overview.storeId}#OVERVIEW`,
      `STORE#${overview.storeId}|SETTINGS`,
      "SLUG#candly|STORE",
    ]);
    expect(puts[2].Item.storeId).toBe(overview.storeId);
    expect(puts.every((p: any) => p.ConditionExpression.startsWith("attribute_not_exists(pk)"))).toBe(true);
  });

  it("updateStoreSettings never persists the admin block and defaults customize", async () => {
    const settings: any = initStoreSettings();
    delete settings.customize;
    await updateStoreSettings("S1", settings);

    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual({ pk: "STORE#S1", sk: "SETTINGS" });
    expect(input.ExpressionAttributeValues?.[":customize"]).toEqual({});
    expect(JSON.stringify(input.ExpressionAttributeNames)).not.toContain("admin");
  });
});
