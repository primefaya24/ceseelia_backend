import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createStore, updateStoreSettings } from "../layers/aws/dynamodb/dynamo-entities/store";
import { initStoreSettings } from "../layers/core/interfaces/store";

const ddb = mockClient(DynamoDBDocumentClient);
// The batch helper reuses (and mutates) its input object, so snapshot it at call time
let batchInputs: any[] = [];

beforeEach(() => {
  ddb.reset();
  batchInputs = [];
  ddb.on(BatchWriteCommand).callsFake((input) => {
    batchInputs.push(structuredClone(input));
    return { UnprocessedItems: {} };
  });
  ddb.on(UpdateCommand).resolves({});
});

describe("store entity", () => {
  it("createStore writes the overview and default settings", async () => {
    const overview = await createStore("Candly", "candly");
    expect(overview.storeName).toBe("Candly");
    expect(overview.storeId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    expect(batchInputs.length).toBe(1);
    const requests = Object.values(batchInputs[0].RequestItems ?? {}).flat();
    const keys = requests.map((r: any) => `${r.PutRequest.Item.pk}|${r.PutRequest.Item.sk}`);
    expect(keys).toContain(`APP_STORE|STORE#${overview.storeId}#OVERVIEW`);
    expect(keys).toContain(`STORE#${overview.storeId}|SETTINGS`);
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
