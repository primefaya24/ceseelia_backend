import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { ulid } from "ulid";

vi.mock("../layers/aws/cognito", () => ({
  verifyCognitoAccessToken: vi.fn(),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";
import {
  initStoreCategory,
  initStoreSettings,
  isStoreItemPure,
  isStoreItemValid,
  StoreItem,
  StoreItemVariant,
  StoreParameter,
} from "../layers/core/interfaces/store";
import {
  combinationCount,
  findVariant,
  MAX_VARIANTS,
  variantCombinations,
  variantsReady,
  variantTotals,
  withVariantTotals,
} from "../layers/core/variants";
import { toPublicInventory } from "../layers/aws/dynamodb/dynamo-entities/store";
import { priceLines, PricingStore, QuoteLineInput } from "../layers/core/pricing";

/*
 * Stock and price per option combination (2.7).
 */

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);

const STORE = ulid();
const CAT = ulid();

const size: StoreParameter = { storeParamLabel: "Size", storeParamType: "SINGLE_SELECT", storeParamIsMandatory: true, storeParamOptions: ["M", "L"] };
const color: StoreParameter = { storeParamLabel: "Color", storeParamType: "SINGLE_SELECT", storeParamIsMandatory: true, storeParamOptions: ["White", "Black"] };
const extras: StoreParameter = { storeParamLabel: "Extras", storeParamType: "MULTI_SELECT", storeParamIsMandatory: false, storeParamOptions: ["Wrap"] };

const row = (options: Record<string, string>, stock: number, prices: Record<string, number> = { USD: 1000 }, active = true): StoreItemVariant => ({
  storeVariantOptions: options,
  storeVariantStock: stock,
  storeVariantPrices: prices,
  storeVariantIsActive: active,
});

/** The hoodie: M/White 2, M/Black 1, L/White 1 at $12, L/Black not made. */
const hoodieRows = (): StoreItemVariant[] => [
  row({ Size: "M", Color: "White" }, 2),
  row({ Size: "M", Color: "Black" }, 1),
  row({ Size: "L", Color: "White" }, 1, { USD: 1200, CAD: 1500 }),
  row({ Size: "L", Color: "Black" }, 0, {}, false),
];

const item = (patch: Partial<StoreItem> = {}): StoreItem => ({
  storeItemId: "HOODIE",
  storeItemCategoryId: CAT,
  storeItemImageUris: [],
  storeItemName: "Hoodie",
  storeItemStock: 0,
  storeItemPrices: { USD: 1 },
  storeItemDescription: "",
  storeItemIsActive: true,
  storeItemHashtagIds: [],
  storeItemDiscountPercent: 0,
  storeItemCustomParams: [size, color, extras],
  storeItemVariants: hoodieRows(),
  ...patch,
});

/** What the create-item route does: shape the item, then check it. */
const savedOk = (i: StoreItem) => {
  if (!isStoreItemPure(i)) return false;
  return isStoreItemValid(withVariantTotals(i), STORE, undefined);
};

beforeEach(() => {
  ddb.reset();
  s3.reset();
  s3.onAnyCommand().resolves({});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("combinations", () => {
  it("are every pick of one option per single-choice param, in param and option order", () => {
    expect(variantCombinations([size, color, extras])).toEqual([
      { Size: "M", Color: "White" },
      { Size: "M", Color: "Black" },
      { Size: "L", Color: "White" },
      { Size: "L", Color: "Black" },
    ]);
    expect(combinationCount([size, color])).toBe(4);
  });

  it("ignore add-ons, blank options and params without options", () => {
    const blank = { ...size, storeParamOptions: ["M", " ", ""] };
    const empty = { ...color, storeParamOptions: [""] };
    expect(variantCombinations([blank, empty, extras])).toEqual([{ Size: "M" }]);
    expect(variantCombinations([extras])).toEqual([]);
  });

  it("stop at the cap", () => {
    const big = { ...size, storeParamOptions: Array.from({ length: 11 }, (_, i) => `S${i}`) };
    const big2 = { ...color, storeParamOptions: Array.from({ length: 10 }, (_, i) => `C${i}`) };
    expect(combinationCount([big, big2])).toBe(110);
    expect(110).toBeGreaterThan(MAX_VARIANTS);
    expect(variantCombinations([big, big2])).toEqual([]);
  });
});

describe("withVariantTotals (what gets saved)", () => {
  it("works out stock (sold rows) and lowest prices from the rows, ignoring what the client sent", () => {
    const saved = withVariantTotals(item({ storeItemStock: 999, storeItemPrices: { USD: 5 } }));
    expect(saved.storeItemStock).toBe(4);
    expect(saved.storeItemPrices).toEqual({ USD: 1000, CAD: 1500 });
  });

  it("any unlimited sold row makes the item unlimited; rows not sold don't count", () => {
    const rows = hoodieRows();
    rows[3] = row({ Size: "L", Color: "Black" }, -1, {}, false);
    expect(variantTotals(rows).stock).toBe(4);
    rows[0] = row({ Size: "M", Color: "White" }, -1);
    expect(variantTotals(rows).stock).toBe(-1);
  });

  it("trims labels, makes variant params required, and puts rows in combination order", () => {
    const saved = withVariantTotals(
      item({
        storeItemCustomParams: [{ ...size, storeParamLabel: " Size ", storeParamIsMandatory: false, storeParamOptions: [" M", "L "] }, color, extras],
        storeItemVariants: [...hoodieRows()].reverse(),
      })
    );
    expect(saved.storeItemCustomParams[0]).toMatchObject({ storeParamLabel: "Size", storeParamIsMandatory: true, storeParamOptions: ["M", "L"] });
    expect(saved.storeItemCustomParams[2].storeParamIsMandatory).toBe(false); // add-ons keep their choice
    expect(saved.storeItemVariants!.map((v) => v.storeVariantOptions)).toEqual(variantCombinations([size, color]));
  });

  it("follows the merchant's option order: reordering options reorders the saved rows", () => {
    const reordered = withVariantTotals(
      item({ storeItemCustomParams: [{ ...size, storeParamOptions: ["L", "M"] }, { ...color, storeParamOptions: ["Black", "White"] }, extras] })
    );
    expect(reordered.storeItemVariants!.map((v) => `${v.storeVariantOptions.Size}/${v.storeVariantOptions.Color}`)).toEqual([
      "L/Black",
      "L/White",
      "M/Black",
      "M/White",
    ]);
    // Same rows, same values: only the order changed.
    expect(findVariant(reordered, { Size: "M", Color: "White" })?.storeVariantStock).toBe(2);
    expect(reordered.storeItemStock).toBe(4);
  });

  it("drops rows for options that no longer exist", () => {
    const saved = withVariantTotals(item({ storeItemCustomParams: [{ ...size, storeParamOptions: ["M"] }, color] }));
    expect(saved.storeItemVariants).toHaveLength(2);
    expect(saved.storeItemStock).toBe(3);
  });

  it("an item with no single-choice params keeps its own stock and prices, and has no rows", () => {
    const saved = withVariantTotals(item({ storeItemCustomParams: [extras], storeItemStock: 7, storeItemPrices: { USD: 300 } }));
    expect(saved).toMatchObject({ storeItemStock: 7, storeItemPrices: { USD: 300 }, storeItemVariants: [] });
  });
});

describe("validation", () => {
  it("accepts a full table, and an item without variants (rows missing on old items too)", () => {
    expect(savedOk(item())).toBe(true);
    expect(savedOk(item({ storeItemCustomParams: [], storeItemVariants: undefined, storeItemStock: 3 }))).toBe(true);
  });

  it.each([
    ["a missing combination", (i: StoreItem) => (i.storeItemVariants = i.storeItemVariants!.slice(1))],
    ["no rows at all", (i: StoreItem) => (i.storeItemVariants = [])],
    ["the same combination twice", (i: StoreItem) => (i.storeItemVariants![1] = { ...i.storeItemVariants![0] })],
    ["no sold combination", (i: StoreItem) => i.storeItemVariants!.forEach((v) => (v.storeVariantIsActive = false))],
    ["a sold combination with no price", (i: StoreItem) => (i.storeItemVariants![0].storeVariantPrices = {})],
    ["a fractional price", (i: StoreItem) => (i.storeItemVariants![0].storeVariantPrices = { USD: 10.5 })],
    ["an unknown currency", (i: StoreItem) => (i.storeItemVariants![0].storeVariantPrices = { EUR: 100 })],
    ["fractional stock", (i: StoreItem) => (i.storeItemVariants![0].storeVariantStock = 1.5)],
    ["stock below -1", (i: StoreItem) => (i.storeItemVariants![0].storeVariantStock = -2)],
    ["stock over the max", (i: StoreItem) => (i.storeItemVariants![0].storeVariantStock = 1_000_001)],
    ["two params with one label", (i: StoreItem) => (i.storeItemCustomParams[1] = { ...color, storeParamLabel: "Size" })],
    ["a repeated option", (i: StoreItem) => (i.storeItemCustomParams[0] = { ...size, storeParamOptions: ["M", "L", "M"] })],
    ["more combinations than the cap", (i: StoreItem) => {
      i.storeItemCustomParams = [
        { ...size, storeParamOptions: Array.from({ length: 11 }, (_, n) => `S${n}`) },
        { ...color, storeParamOptions: Array.from({ length: 10 }, (_, n) => `C${n}`) },
      ];
      i.storeItemVariants = variantCombinations([i.storeItemCustomParams[0]]).flatMap((s) =>
        Array.from({ length: 10 }, (_, n) => row({ ...s, Color: `C${n}` }, 1))
      );
    }],
  ])("refuses %s", (_n, change) => {
    const i = item();
    change(i);
    expect(savedOk(i)).toBe(false);
  });

  it("a combination that isn't sold may have no price", () => {
    expect(savedOk(item())).toBe(true); // L/Black has {}
  });

  it("refuses rows that aren't the right shape", () => {
    expect(isStoreItemPure(item({ storeItemVariants: [{ storeVariantOptions: { Size: 1 } }] as never }))).toBe(false);
    expect(isStoreItemPure(item({ storeItemVariants: "x" as never }))).toBe(false);
  });
});

describe("public data", () => {
  const data = (items: StoreItem[]) => {
    const settings = initStoreSettings();
    settings.currencies = [{ currencyCode: "USD", currencySign: "$", currencyIsDefault: true }] as never;
    return toPublicInventory({ settings, categories: [{ ...initStoreCategory(CAT, "Hoodies"), storeCategoryIsActive: true }], items });
  };

  it("leaves out combinations that aren't sold, and prices in currencies the store doesn't offer", () => {
    const out = data([withVariantTotals(item())]).items[0];
    expect(out.storeItemVariants!.map((v) => v.storeVariantOptions)).toEqual([
      { Size: "M", Color: "White" },
      { Size: "M", Color: "Black" },
      { Size: "L", Color: "White" },
    ]);
    expect(out.storeItemVariants![2].storeVariantPrices).toEqual({ USD: 1200 });
  });

  it("hides an item whose table isn't filled in (saved before variants)", () => {
    const old = item({ storeItemVariants: undefined, storeItemStock: 5 });
    expect(variantsReady(old)).toBe(false);
    expect(data([old]).items).toEqual([]);
    expect(data([old]).categories[0].storeCategoryItemCount).toBe(0);
  });
});

describe("quote (2.7)", () => {
  const store = (items: StoreItem[]): PricingStore => {
    const settings = initStoreSettings();
    return {
      settings: { currencies: [{ currencyCode: "USD", currencySign: "$", currencyIsDefault: true }] as never, general: settings.general },
      categories: [{ ...initStoreCategory(CAT, "Hoodies"), storeCategoryIsActive: true }],
      items: items.map(withVariantTotals),
    };
  };
  const pick = (s: string, c: string, extra: string[] = []) => [
    { label: "Size", values: [s] },
    { label: "Color", values: [c] },
    ...(extra.length ? [{ label: "Extras", values: extra }] : []),
  ];
  const l = (s: string, c: string, quantity = 1, extra: string[] = []) => ({ itemId: "HOODIE", quantity, params: pick(s, c, extra) });

  it("charges the combination's price", () => {
    const q = priceLines(store([item()]), [l("M", "White"), l("L", "White")], "USD");
    expect(q.lines.map((x) => x.unitPriceMinor)).toEqual([1000, 1200]);
    expect(q.ok).toBe(true);
  });

  it("each combination has its own stock; lines of the same combination share it (add-ons too)", () => {
    const q = priceLines(store([item()]), [l("M", "Black"), l("M", "Black", 1, ["Wrap"]), l("M", "White", 2)], "USD");
    expect(q.lines.map((x) => x.error?.code ?? null)).toEqual([null, "OUT_OF_STOCK", null]);
    const more = priceLines(store([item()]), [l("M", "White", 3)], "USD");
    expect(more.lines[0].error).toMatchObject({ code: "INSUFFICIENT_STOCK", available: 2 });
  });

  it("refuses crafted lines for a combination with no stock, however they're sent", () => {
    const rows = hoodieRows();
    rows[1] = row({ Size: "M", Color: "Black" }, 0); // sold, but none left
    const s = store([item({ storeItemVariants: rows })]);
    const codes = (lines: QuoteLineInput[]) => priceLines(s, lines, "USD").lines.map((x) => x.error?.code ?? null);
    expect(codes([l("M", "Black")])).toEqual(["OUT_OF_STOCK"]);
    // Picks in another order, padded with spaces, or with an add-on: still that combination.
    expect(codes([{ itemId: "HOODIE", quantity: 1, params: [{ label: "Color", values: [" Black "] }, { label: "Size", values: ["M"] }] }])).toEqual(["OUT_OF_STOCK"]);
    expect(codes([l("M", "Black", 1, ["Wrap"])])).toEqual(["OUT_OF_STOCK"]);
    // Leaving a choice out, picking two sizes, or a size that doesn't exist.
    expect(codes([{ itemId: "HOODIE", quantity: 1, params: [{ label: "Color", values: ["Black"] }] }])).toEqual(["MISSING_PARAM"]);
    expect(codes([{ itemId: "HOODIE", quantity: 1, params: [{ label: "Size", values: ["M", "L"] }, { label: "Color", values: ["Black"] }] }])).toEqual(["INVALID_PARAM"]);
    expect(codes([l("XL", "Black")])).toEqual(["INVALID_PARAM"]);
    // Splitting more than the stock over several lines of the same combination.
    expect(codes([l("M", "White"), l("M", "White", 1, ["Wrap"]), l("M", "White")])).toEqual([null, null, "OUT_OF_STOCK"]);
    // A zero, negative or fractional quantity.
    expect(codes([l("M", "White", 0), l("M", "White", -1), l("M", "White", 1.5)])).toEqual(["INVALID_QUANTITY", "INVALID_QUANTITY", "INVALID_QUANTITY"]);
    expect(priceLines(s, [l("M", "Black")], "USD").ok).toBe(false);
  });

  it("a combination that isn't sold can't be bought", () => {
    const q = priceLines(store([item()]), [l("L", "Black")], "USD");
    expect(q.lines[0].error?.code).toBe("OPTION_UNAVAILABLE");
  });

  it("a combination with no price in the currency isn't sold in it", () => {
    const rows = hoodieRows();
    rows[1] = row({ Size: "M", Color: "Black" }, 1, { CAD: 100 });
    const s = store([item({ storeItemVariants: rows })]);
    s.settings.currencies = [
      { currencyCode: "USD", currencySign: "$", currencyIsDefault: true },
      { currencyCode: "CAD", currencySign: "C$", currencyIsDefault: false },
    ] as never;
    expect(priceLines(s, [l("M", "Black")], "USD").lines[0].error?.code).toBe("NOT_SOLD_IN_CURRENCY");
    expect(priceLines(s, [l("M", "Black")], "CAD").lines[0].unitPriceMinor).toBe(100);
  });

  it("variant params are required even if saved as optional", () => {
    const raw = item({ storeItemCustomParams: [{ ...size, storeParamIsMandatory: false }, color, extras] });
    const s = store([raw]);
    s.items[0].storeItemCustomParams[0].storeParamIsMandatory = false;
    const q = priceLines(s, [{ itemId: "HOODIE", quantity: 1, params: [{ label: "Color", values: ["White"] }] }], "USD");
    expect(q.lines[0].error).toMatchObject({ code: "MISSING_PARAM", param: "Size" });
  });

  it("an item whose table isn't filled in can't be bought", () => {
    const s = store([]);
    s.items = [item({ storeItemVariants: undefined, storeItemStock: 5 })];
    expect(priceLines(s, [l("M", "White")], "USD").lines[0].error?.code).toBe("ITEM_NOT_FOUND");
  });

  it("finds rows by labels, whatever order the picks come in", () => {
    expect(findVariant(item(), { Color: "Black", Size: "M", Extras: "Wrap" })?.storeVariantStock).toBe(1);
  });
});

describe("POST /store/inventory/create-item (2.7)", () => {
  const app = createApp();
  const save = (storeItem: StoreItem) =>
    request(app)
      .post("/api/v1/store/inventory/create-item")
      .set("Host", "localhost")
      .set("Authorization", "Bearer good")
      .send({ storeId: STORE, isUpdate: false, storeItemId: "", storeItem });

  beforeEach(() => {
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "admin-1", "cognito:groups": ["Admins"] });
  });

  it("saves the rows and the stock and prices worked out from them", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const res = await save(item({ storeItemStock: 50, storeItemPrices: { USD: 1 } }));
    expect(res.status).toBe(200);
    const values = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems![1].Update!.ExpressionAttributeValues!;
    expect(values[":storeItemStock"]).toBe(4);
    expect(values[":storeItemPrices"]).toEqual({ USD: 1000, CAD: 1500 });
    expect(values[":storeItemVariants"]).toHaveLength(4);
  });

  it("saves an empty table for an item without single-choice params", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    await save(item({ storeItemCustomParams: [extras], storeItemVariants: hoodieRows(), storeItemStock: 3 }));
    const values = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems![1].Update!.ExpressionAttributeValues!;
    expect(values[":storeItemVariants"]).toEqual([]);
    expect(values[":storeItemStock"]).toBe(3);
  });

  it("400 for a table with a missing combination", async () => {
    const res = await save(item({ storeItemVariants: hoodieRows().slice(1) }));
    expect(res.status).toBe(400);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
