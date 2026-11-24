import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  findUserIdByCognitoId: vi.fn(),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getMembership: vi.fn(),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { findUserIdByCognitoId } from "../layers/aws/dynamodb/dynamo-entities/user";
import { getMembership } from "../layers/aws/dynamodb/dynamo-entities/membership";
import { createApp } from "../app";
import { setFxRates } from "../layers/core/fx";
import { movePrices, moveItemPrices, moveSettings } from "../layers/core/fx/main-currency";
import { mainCurrencyLimits } from "../api/v1/store/currencies";
import { StoreItem } from "../layers/core/interfaces/store";

const RATES = { date: "2026-11-23", rates: { USD: 1, CAD: 1.4, AUD: 1.5 } };
const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = "01JBZ0000000000000000000S1";
const usd = { currencyCode: "USD", currencySign: "$", currencyFloat: "LEFT", currencyIsDefault: true };

describe("moving prices (T.5)", () => {
  it("KEEP_NUMBERS relabels; nothing to move = null", () => {
    expect(movePrices({ USD: 2500 }, "USD", "CAD", "KEEP_NUMBERS", null, "EXACT")).toEqual({ CAD: 2500 });
    expect(movePrices({ USD: 2500, CAD: 9999 }, "USD", "CAD", "KEEP_NUMBERS", null, "EXACT")).toEqual({ CAD: 2500 });
    expect(movePrices({ CAD: 2500 }, "USD", "CAD", "KEEP_NUMBERS", null, "EXACT")).toBeNull();
  });

  it("CONVERT keeps a hand-set price in the new one and the old prices; converts the rest", () => {
    expect(movePrices({ USD: 2500 }, "USD", "CAD", "CONVERT", RATES, "NINETY_NINE")).toEqual({ USD: 2500, CAD: 3499 });
    expect(movePrices({ USD: 2500, CAD: 3000 }, "USD", "CAD", "CONVERT", RATES, "EXACT")).toBeNull();
    expect(movePrices({ USD: 2500 }, "USD", "CAD", "CONVERT", null, "EXACT")).toBeNull();
  });

  it("variant rows move and the item's prices follow its sold rows", () => {
    const item = {
      storeItemPrices: { USD: 1000 },
      storeItemVariants: [
        { storeVariantOptions: { S: "a" }, storeVariantStock: 1, storeVariantPrices: { USD: 1000 }, storeVariantIsActive: true },
        { storeVariantOptions: { S: "b" }, storeVariantStock: 1, storeVariantPrices: { USD: 1500 }, storeVariantIsActive: true },
      ],
    } as unknown as StoreItem;
    const out = moveItemPrices(item, "USD", "CAD", "KEEP_NUMBERS", null, "EXACT");
    expect(out.storeItemVariants.map((v) => v.storeVariantPrices)).toEqual([{ CAD: 1000 }, { CAD: 1500 }]);
    expect(out.storeItemPrices).toEqual({ CAD: 1000 });
    const moved = moveItemPrices(out, "USD", "CAD", "KEEP_NUMBERS", null, "EXACT");
    expect(moved).toBe(out);
  });

  it("settings: the new currency is added and made main; fees move", () => {
    const s = moveSettings({ currencies: [usd as any], general: { deliveryFees: { USD: 500 } } as any }, "CAD", "KEEP_NUMBERS", null);
    expect(s.currencies.map((c) => [c.currencyCode, c.currencyIsDefault, c.currencySign])).toEqual([
      ["USD", false, "$"],
      ["CAD", true, "C$"],
    ]);
    expect(s.general.deliveryFees).toEqual({ CAD: 500 });
  });
});

describe("POST /store/currencies/main (T.5)", () => {
  const items = [
    { pk: `STORE#${STORE}`, sk: "ITEM#I1", storeItemId: "I1", storeItemStock: 3, storeItemCustomParams: [], storeItemPrices: { USD: 2500 } },
    { pk: `STORE#${STORE}`, sk: "ITEM#I2", storeItemId: "I2", storeItemStock: 3, storeItemCustomParams: [], storeItemPrices: { CAD: 900 } },
  ];
  const post = (body: object) =>
    request(app).post("/api/v1/store/currencies/main").set("Host", "localhost").set("Authorization", "Bearer t").send({ storeId: STORE, ...body });

  beforeEach(() => {
    ddb.reset();
    mainCurrencyLimits.perStore.reset();
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "c1", "cognito:groups": [] } as any);
    vi.mocked(findUserIdByCognitoId).mockResolvedValue("U1");
    vi.mocked(getMembership).mockResolvedValue({ storeId: STORE, userId: "U1", role: "ADMIN", createdAt: 1 } as any);
    vi.spyOn(console, "error").mockImplementation(() => {});
    ddb.on(QueryCommand).callsFake((input) =>
      input.ExpressionAttributeValues[":sk_prefix"] === "ITEM#" ? { Items: items } : { Items: [] }
    );
    ddb.on(GetCommand).callsFake((input) =>
      input.Key.sk === "SETTINGS"
        ? { Item: { pk: `STORE#${STORE}`, sk: "SETTINGS", currencies: [usd], general: { deliveryFees: { USD: 500 } } } }
        : { Item: items.find((i) => i.sk === input.Key.sk) }
    );
    ddb.on(UpdateCommand).resolves({});
  });
  afterEach(() => setFxRates(null));

  it("KEEP_NUMBERS: items relabelled one by one, then the settings", async () => {
    const res = await post({ currencyCode: "CAD", mode: "KEEP_NUMBERS" });
    expect(res.status).toBe(200);
    expect(res.body.itemsUpdated).toBe(1);
    expect(res.body.deliveryFees).toEqual({ CAD: 500 });
    const updates = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates).toHaveLength(2);
    expect(updates[0].ExpressionAttributeValues![":pr"]).toEqual({ CAD: 2500 });
    expect(updates[1].Key).toEqual({ pk: `STORE#${STORE}`, sk: "SETTINGS" });
    expect(updates[1].ExpressionAttributeValues![":c"].map((c: any) => [c.currencyCode, c.currencyIsDefault])).toEqual([
      ["USD", false],
      ["CAD", true],
    ]);
  });

  it("CONVERT needs rates (503), then converts", async () => {
    expect((await post({ currencyCode: "CAD", mode: "CONVERT" })).body.code).toBe("FX_UNAVAILABLE");
    setFxRates(RATES);
    const res = await post({ currencyCode: "CAD", mode: "CONVERT" });
    expect(res.status).toBe(200);
    expect(ddb.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues![":pr"]).toEqual({ USD: 2500, CAD: 3499 });
  });

  it("an item that keeps changing: 409 ITEMS_CHANGED and the settings aren't touched", async () => {
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
    const res = await post({ currencyCode: "CAD", mode: "KEEP_NUMBERS" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ITEMS_CHANGED");
    expect(ddb.commandCalls(UpdateCommand).every((c) => c.args[0].input.Key!.sk !== "SETTINGS")).toBe(true);
  });

  it("the same currency changes nothing; bad input is a 400; MERCHANT members can't", async () => {
    expect((await post({ currencyCode: "USD", mode: "KEEP_NUMBERS" })).body.itemsUpdated).toBe(0);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    expect((await post({ currencyCode: "EUR", mode: "KEEP_NUMBERS" })).status).toBe(400);
    expect((await post({ currencyCode: "CAD", mode: "SWAP" })).status).toBe(400);
    vi.mocked(getMembership).mockResolvedValue({ storeId: STORE, userId: "U1", role: "MERCHANT", createdAt: 1 } as any);
    expect((await post({ currencyCode: "CAD", mode: "KEEP_NUMBERS" })).status).toBe(403);
  });
});
