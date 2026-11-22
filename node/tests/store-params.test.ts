import { describe, it, expect } from "vitest";
import { ulid } from "ulid";
import {
  isStoreItemValid,
  isStoreParamDefPure,
  isStoreParamDefValid,
  StoreItem,
  StoreItemVariant,
  StoreParamDef,
  StoreParameter,
} from "../layers/core/interfaces/store";
import {
  applyParamDef,
  cleanParamDef,
  itemParamFromDef,
  itemParamsChanged,
  itemUsesParam,
  paramKey,
  removeParamFromItem,
  sameParamKey,
  syncItemParams,
  UnknownStoreParamError,
} from "../layers/core/store-params";
import { hasVariants, variantParams, withVariantTotals } from "../layers/core/variants";
import { checkParams } from "../layers/core/pricing";

/*
 * Store parameters, linked to items (progress.md Stage R).
 */

const STORE = ulid();
const CAT = ulid();
const ITEM = ulid();

const def = (over: Partial<StoreParamDef> = {}): StoreParamDef => ({
  storeParamId: ulid(),
  storeParamName: "Shape",
  storeParamTag: "",
  storeParamType: "SINGLE_SELECT",
  storeParamIsMandatory: true,
  storeParamOptions: ["Coffin", "Square", "Almond"],
  storeParamHasVariants: false,
  ...over,
});

const item = (params: StoreParameter[], over: Partial<StoreItem> = {}): StoreItem => ({
  storeItemId: ITEM,
  storeItemCategoryId: CAT,
  storeItemImageUris: [],
  storeItemName: "Cute N Spooky",
  storeItemStock: 5,
  storeItemPrices: { CAD: 3500 },
  storeItemDescription: "",
  storeItemIsActive: true,
  storeItemHashtagIds: [],
  storeItemDiscountPercent: 0,
  storeItemCustomParams: params,
  storeItemVariants: [],
  ...over,
});

const row = (o: Record<string, string>, stock: number, cad = 3500, active = true): StoreItemVariant => ({
  storeVariantOptions: o,
  storeVariantStock: stock,
  storeVariantPrices: { CAD: cad },
  storeVariantIsActive: active,
});

const valid = (i: StoreItem) => isStoreItemValid(i, STORE, ITEM);

describe("keys and the parameter's own checks", () => {
  it("name#tag, or the name alone; compared ignoring case", () => {
    expect(paramKey({ storeParamName: "Size", storeParamTag: "Rings" })).toBe("Size#Rings");
    expect(paramKey({ storeParamName: " Size ", storeParamTag: "  " })).toBe("Size");
    expect(sameParamKey({ storeParamName: "size", storeParamTag: "" }, { storeParamName: "Size", storeParamTag: "" })).toBe(true);
    expect(sameParamKey({ storeParamName: "Size", storeParamTag: "Rings" }, { storeParamName: "Size", storeParamTag: "" })).toBe(false);
  });

  it("cleans: trims, drops blank options, no variants on multiple choice", () => {
    const d = cleanParamDef(def({ storeParamName: " Shape ", storeParamOptions: [" A ", "", "B"], storeParamType: "MULTI_SELECT", storeParamHasVariants: true }));
    expect(d.storeParamName).toBe("Shape");
    expect(d.storeParamOptions).toEqual(["A", "B"]);
    expect(d.storeParamHasVariants).toBe(false);
  });

  it("valid: name, tag without #, 1–30 unique options", () => {
    expect(isStoreParamDefPure(def())).toBe(true);
    expect(isStoreParamDefPure({ ...def(), storeParamHasVariants: "no" })).toBe(false);
    expect(isStoreParamDefValid(def())).toBe(true);
    expect(isStoreParamDefValid(def({ storeParamName: "" }))).toBe(false);
    expect(isStoreParamDefValid(def({ storeParamName: "Si#ze" }))).toBe(false);
    expect(isStoreParamDefValid(def({ storeParamTag: "a#b" }))).toBe(false);
    expect(isStoreParamDefValid(def({ storeParamTag: "x".repeat(31) }))).toBe(false);
    expect(isStoreParamDefValid(def({ storeParamOptions: [] }))).toBe(false);
    expect(isStoreParamDefValid(def({ storeParamOptions: ["Long", "long"] }))).toBe(false);
    expect(isStoreParamDefValid(def({ storeParamOptions: Array.from({ length: 31 }, (_, i) => `o${i}`) }))).toBe(false);
    expect(isStoreParamDefValid(def({ storeParamType: "MULTI_SELECT", storeParamHasVariants: true }))).toBe(false);
  });
});

describe("the variant rule with the switch (R.0b)", () => {
  it("single choice with variants off is not a variant param; missing = on", () => {
    const off = itemParamFromDef(def());
    const on = itemParamFromDef(def({ storeParamHasVariants: true }));
    const legacy: StoreParameter = { storeParamLabel: "Size", storeParamType: "SINGLE_SELECT", storeParamIsMandatory: true, storeParamOptions: ["S"] };
    expect(variantParams([off])).toEqual([]);
    expect(variantParams([on])).toHaveLength(1);
    expect(variantParams([legacy])).toHaveLength(1);
  });

  it("an item with only a switched-off single choice keeps one price and stock, no rows", () => {
    const i = withVariantTotals(item([itemParamFromDef(def())]));
    expect(hasVariants(i)).toBe(false);
    expect(i.storeItemVariants).toEqual([]);
    expect(i.storeItemStock).toBe(5);
    expect(valid(i)).toBe(true);
  });

  it("an optional single choice with variants off stays optional", () => {
    const i = withVariantTotals(item([itemParamFromDef(def({ storeParamIsMandatory: false }))]));
    expect(i.storeItemCustomParams[0].storeParamIsMandatory).toBe(false);
  });

  it("the quote asks for exactly one option", () => {
    const p = [itemParamFromDef(def())];
    expect(checkParams(p, [])).toMatchObject({ error: { code: "MISSING_PARAM" } });
    expect(checkParams(p, [{ label: "Shape", values: ["Coffin", "Square"] }])).toMatchObject({ error: { code: "INVALID_PARAM" } });
    expect(checkParams(p, [{ label: "Shape", values: ["Coffin"] }])).toEqual({ params: [{ label: "Shape", values: ["Coffin"] }] });
  });
});

describe("item save takes the store's parameters (R.4)", () => {
  it("rewrites a linked copy from the store parameter, keeps item-only params", () => {
    const d = def();
    const legacy: StoreParameter = { storeParamLabel: "Gift", storeParamType: "MULTI_SELECT", storeParamIsMandatory: false, storeParamOptions: ["Wrap"] };
    const sent = item([{ storeParamId: d.storeParamId, storeParamLabel: "hacked", storeParamType: "MULTI_SELECT", storeParamIsMandatory: false, storeParamOptions: ["x"] }, legacy]);
    const out = syncItemParams(sent, [d]);
    expect(out.storeItemCustomParams[0]).toEqual(itemParamFromDef(d));
    expect(out.storeItemCustomParams[1]).toBe(legacy);
  });

  it("an unknown id throws", () => {
    expect(() => syncItemParams(item([{ ...itemParamFromDef(def()) }]), [])).toThrow(UnknownStoreParamError);
  });
});

describe("a parameter edit reshapes the items using it (R.0c)", () => {
  const size = def({ storeParamName: "Size", storeParamOptions: ["S", "L"], storeParamHasVariants: true });
  const shapeOn = def({ storeParamHasVariants: true, storeParamOptions: ["Coffin", "Square"] });

  /** Shape × Size, every row set by the merchant. */
  const variantItem = () =>
    withVariantTotals(
      item([itemParamFromDef(shapeOn), itemParamFromDef(size)], {
        storeItemVariants: [
          row({ Shape: "Coffin", Size: "S" }, 2, 3000),
          row({ Shape: "Coffin", Size: "L" }, 3, 3200),
          row({ Shape: "Square", Size: "S" }, -1, 3100),
          row({ Shape: "Square", Size: "L" }, 0, 3300, false),
        ],
      })
    );

  it("doesn't touch an item that doesn't use it", () => {
    const i = variantItem();
    expect(applyParamDef(i, def(), {})).toBe(i);
    expect(itemUsesParam(i, shapeOn.storeParamId)).toBe(true);
  });

  it("a renamed option keeps its rows", () => {
    const i = variantItem();
    const out = applyParamDef(i, { ...shapeOn, storeParamOptions: ["Coffin", "Squoval"] }, { Square: "Squoval" });
    expect(out.storeItemVariants).toEqual([
      row({ Shape: "Coffin", Size: "S" }, 2, 3000),
      row({ Shape: "Coffin", Size: "L" }, 3, 3200),
      row({ Shape: "Squoval", Size: "S" }, -1, 3100),
      row({ Shape: "Squoval", Size: "L" }, 0, 3300, false),
    ]);
    expect(valid(out)).toBe(true);
  });

  it("a renamed parameter keeps its rows", () => {
    const out = applyParamDef(variantItem(), { ...shapeOn, storeParamName: "Nail shape" });
    expect(out.storeItemVariants?.[0].storeVariantOptions).toEqual({ "Nail shape": "Coffin", Size: "S" });
    expect(out.storeItemVariants?.[0].storeVariantStock).toBe(2);
    expect(valid(out)).toBe(true);
  });

  it("a new option copies the first option's rows, with no invented stock", () => {
    const out = applyParamDef(variantItem(), { ...shapeOn, storeParamOptions: ["Coffin", "Square", "Almond"] });
    const almond = out.storeItemVariants!.filter((r) => r.storeVariantOptions.Shape === "Almond");
    expect(almond).toEqual([row({ Shape: "Almond", Size: "S" }, 0, 3000), row({ Shape: "Almond", Size: "L" }, 0, 3200)]);
    expect(valid(out)).toBe(true);
  });

  it("a new option next to an unlimited row is unlimited too", () => {
    const i = withVariantTotals(item([itemParamFromDef(shapeOn)], { storeItemVariants: [row({ Shape: "Coffin" }, -1), row({ Shape: "Square" }, 4)] }));
    const out = applyParamDef(i, { ...shapeOn, storeParamOptions: ["Coffin", "Square", "Almond"] });
    expect(out.storeItemVariants![2]).toEqual(row({ Shape: "Almond" }, -1));
  });

  it("a removed option drops its rows; totals follow", () => {
    const out = applyParamDef(variantItem(), { ...shapeOn, storeParamOptions: ["Coffin"] });
    expect(out.storeItemVariants).toHaveLength(2);
    expect(out.storeItemStock).toBe(5);
    expect(out.storeItemPrices).toEqual({ CAD: 3000 });
    expect(valid(out)).toBe(true);
  });

  it("switching variants off merges rows: sold stock summed, first sold row's price", () => {
    const out = applyParamDef(variantItem(), { ...shapeOn, storeParamHasVariants: false });
    // Size still makes rows: S = Coffin/S (2) + Square/S (unlimited); L = Coffin/L (3), Square/L not sold.
    expect(out.storeItemVariants).toEqual([row({ Size: "S" }, -1, 3000), row({ Size: "L" }, 3, 3200)]);
    expect(out.storeItemCustomParams[0].storeParamHasVariants).toBe(false);
    expect(valid(out)).toBe(true);
  });

  it("switching the last variant param off leaves one price and stock", () => {
    const i = withVariantTotals(item([itemParamFromDef(shapeOn)], { storeItemVariants: [row({ Shape: "Coffin" }, 2, 3000), row({ Shape: "Square" }, 3, 3500)] }));
    const out = applyParamDef(i, { ...shapeOn, storeParamHasVariants: false });
    expect(out.storeItemVariants).toEqual([]);
    expect(out.storeItemStock).toBe(5);
    expect(out.storeItemPrices).toEqual({ CAD: 3000 });
    expect(valid(out)).toBe(true);
  });

  it("switching variants on: the item's price everywhere, the first option takes the stock", () => {
    const off = def();
    const i = withVariantTotals(item([itemParamFromDef(off)]));
    const out = applyParamDef(i, { ...off, storeParamHasVariants: true });
    expect(out.storeItemVariants).toEqual([
      row({ Shape: "Coffin" }, 5, 3500),
      row({ Shape: "Square" }, 0, 3500),
      row({ Shape: "Almond" }, 0, 3500),
    ]);
    expect(out.storeItemStock).toBe(5);
    expect(valid(out)).toBe(true);
  });

  it("switching variants on next to another variant param multiplies its rows", () => {
    const sizeOnly = withVariantTotals(
      item([itemParamFromDef(def()), itemParamFromDef(size)], { storeItemVariants: [row({ Size: "S" }, -1, 3000), row({ Size: "L" }, 2, 3200)] })
    );
    const shapeId = sizeOnly.storeItemCustomParams[0].storeParamId!;
    const out = applyParamDef(sizeOnly, { ...def(), storeParamId: shapeId, storeParamHasVariants: true, storeParamOptions: ["Coffin", "Square"] });
    expect(out.storeItemVariants).toEqual([
      row({ Shape: "Coffin", Size: "S" }, -1, 3000),
      row({ Shape: "Coffin", Size: "L" }, 2, 3200),
      row({ Shape: "Square", Size: "S" }, -1, 3000),
      row({ Shape: "Square", Size: "L" }, 0, 3200),
    ]);
    expect(valid(out)).toBe(true);
  });

  it("editing a switched-off param only rewrites the copy", () => {
    const off = def();
    const i = withVariantTotals(item([itemParamFromDef(off)]));
    const out = applyParamDef(i, { ...off, storeParamOptions: ["Coffin", "Stiletto"] }, { Square: "Stiletto" });
    expect(out.storeItemCustomParams[0].storeParamOptions).toEqual(["Coffin", "Stiletto"]);
    expect(out.storeItemStock).toBe(5);
    expect(out.storeItemPrices).toEqual({ CAD: 3500 });
    expect(itemParamsChanged(i, out)).toBe(true);
    expect(itemParamsChanged(out, applyParamDef(out, { ...off, storeParamOptions: ["Coffin", "Stiletto"] }))).toBe(false);
  });

  it("multiple choice add-ons never touch the rows", () => {
    const gift = def({ storeParamName: "Gift", storeParamType: "MULTI_SELECT", storeParamIsMandatory: false, storeParamOptions: ["Wrap"] });
    const i = withVariantTotals(
      item([itemParamFromDef(gift), itemParamFromDef(shapeOn)], { storeItemVariants: [row({ Shape: "Coffin" }, 2), row({ Shape: "Square" }, 3)] })
    );
    const out = applyParamDef(i, { ...gift, storeParamOptions: ["Wrap", "Card"] });
    expect(out.storeItemVariants).toEqual(i.storeItemVariants);
  });

  it("removing a parameter: its rows merge (same rule as switching off)", () => {
    const out = removeParamFromItem(variantItem(), shapeOn.storeParamId);
    expect(out.storeItemCustomParams.map((p) => p.storeParamLabel)).toEqual(["Size"]);
    expect(out.storeItemVariants).toEqual([row({ Size: "S" }, -1, 3000), row({ Size: "L" }, 3, 3200)]);
    expect(valid(out)).toBe(true);
  });

  it("removing the only parameter of a plain item", () => {
    const off = def();
    const out = removeParamFromItem(withVariantTotals(item([itemParamFromDef(off)])), off.storeParamId);
    expect(out.storeItemCustomParams).toEqual([]);
    expect(out.storeItemStock).toBe(5);
    expect(valid(out)).toBe(true);
  });

  it("removing every sold option leaves an item the save refuses", () => {
    const i = withVariantTotals(item([itemParamFromDef(shapeOn)], { storeItemVariants: [row({ Shape: "Coffin" }, 2), row({ Shape: "Square" }, 3, 3500, false)] }));
    expect(valid(applyParamDef(i, { ...shapeOn, storeParamOptions: ["Square"] }))).toBe(false);
  });

  it("over 100 combinations is refused", () => {
    const many = (n: number) => Array.from({ length: n }, (_, k) => `o${k}`);
    const a = def({ storeParamName: "A", storeParamHasVariants: true, storeParamOptions: many(10) });
    const b = def({ storeParamName: "B", storeParamHasVariants: true, storeParamOptions: many(10) });
    const rows = many(10).flatMap((x) => many(10).map((y) => row({ A: x, B: y }, 1)));
    const i = withVariantTotals(item([itemParamFromDef(a), itemParamFromDef(b)], { storeItemVariants: rows }));
    expect(valid(i)).toBe(true);
    expect(valid(applyParamDef(i, { ...a, storeParamOptions: many(11) }))).toBe(false);
  });

  it("the same name twice on one item is refused", () => {
    const a = def();
    const b = def({ storeParamTag: "Toes" });
    expect(valid(withVariantTotals(item([itemParamFromDef(a), itemParamFromDef(b)])))).toBe(false);
  });
});
