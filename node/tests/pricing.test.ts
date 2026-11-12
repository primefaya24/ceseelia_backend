import { describe, it, expect } from "vitest";

import {
  bestDiscount,
  checkParams,
  includedTaxOf,
  percentOf,
  priceLines,
  PricingStore,
  QuoteLineInput,
} from "../layers/core/pricing";
import {
  initStoreCategory,
  initStoreSettings,
  StoreItem,
  StoreItemVariant,
  StoreParameter,
} from "../layers/core/interfaces/store";

const size: StoreParameter = { storeParamLabel: "Size", storeParamType: "SINGLE_SELECT", storeParamIsMandatory: true, storeParamOptions: ["S", "M", " ", "L"] };
const extras: StoreParameter = { storeParamLabel: "Extras", storeParamType: "MULTI_SELECT", storeParamIsMandatory: false, storeParamOptions: ["Card", "Wrap"] };

function item(id: string, patch: Partial<StoreItem> = {}): StoreItem {
  return {
    storeItemId: id,
    storeItemCategoryId: "CAT",
    storeItemImageUris: [],
    storeItemDescription: "",
    storeItemHashtagIds: [],
    storeItemName: id,
    storeItemIsActive: true,
    storeItemStock: -1,
    storeItemPrices: { USD: 1000, AUD: 1500 },
    storeItemDiscountPercent: 0,
    storeItemCustomParams: [],
    ...patch,
  } as StoreItem;
}

function store(
  opts: { items?: StoreItem[]; categoryPercent?: number; storePercent?: number; categoryActive?: boolean; general?: object } = {}
): PricingStore {
  const settings = initStoreSettings();
  return {
    settings: {
      currencies: [
        { currencyCode: "USD", currencySign: "$", currencyIsDefault: true },
        { currencyCode: "AUD", currencySign: "A$", currencyIsDefault: false },
      ] as never,
      general: { ...settings.general, discountPercent: opts.storePercent ?? 0, ...opts.general },
    },
    categories: [
      { ...initStoreCategory("CAT", "Drinks"), storeCategoryIsActive: opts.categoryActive ?? true, storeCategoryDiscountPercent: opts.categoryPercent ?? 0 },
    ],
    items: opts.items ?? [item("TEA")],
  };
}
/** One sold row per Size option (S, M, L), $10 / A$15, unlimited. */
const sizeRows = (): StoreItemVariant[] =>
  ["S", "M", "L"].map((o) => ({ storeVariantOptions: { Size: o }, storeVariantStock: -1, storeVariantPrices: { USD: 1000, AUD: 1500 }, storeVariantIsActive: true }));
const line = (itemId: string, quantity = 1, params: QuoteLineInput["params"] = []): QuoteLineInput => ({ itemId, quantity, params });

describe("priceLines (4.1)", () => {
  it("prices lines in the chosen currency and totals them", () => {
    const q = priceLines(store({ items: [item("TEA"), item("CAKE", { storeItemPrices: { USD: 250 } })] }), [line("TEA", 2), line("CAKE", 3)], "USD");
    expect(q.ok).toBe(true);
    expect(q.lines.map((l) => [l.unitPriceMinor, l.subtotalMinor, l.totalMinor])).toEqual([[1000, 2000, 2000], [250, 750, 750]]);
    expect([q.subtotalMinor, q.discountMinor, q.totalMinor]).toEqual([2750, 0, 2750]);
    expect(priceLines(store(), [line("TEA")], "AUD").totalMinor).toBe(1500);
  });

  it("the biggest discount wins: item, category or store, never stacked", () => {
    const tea = item("TEA", { storeItemDiscountPercent: 10 });
    const byCategory = priceLines(store({ items: [tea], categoryPercent: 25, storePercent: 5 }), [line("TEA", 4)], "USD");
    expect(byCategory.lines[0]).toMatchObject({ discountPercent: 25, discountSource: "CATEGORY", subtotalMinor: 4000, discountMinor: 1000, totalMinor: 3000 });
    expect(priceLines(store({ items: [tea], storePercent: 30 }), [line("TEA")], "USD").lines[0]).toMatchObject({ discountPercent: 30, discountSource: "STORE" });
    expect(priceLines(store({ items: [tea], storePercent: 5 }), [line("TEA")], "USD").lines[0]).toMatchObject({ discountPercent: 10, discountSource: "ITEM" });
    expect(priceLines(store(), [line("TEA")], "USD").lines[0]).toMatchObject({ discountPercent: 0, discountSource: null, discountMinor: 0 });
  });

  it("ties go to the most specific source; out-of-range percents are clamped", () => {
    expect(bestDiscount({ storeItemDiscountPercent: 20 }, { storeCategoryDiscountPercent: 20 }, 20)).toEqual({ percent: 20, source: "ITEM" });
    expect(bestDiscount({ storeItemDiscountPercent: 0 }, { storeCategoryDiscountPercent: 20 }, 20)).toEqual({ percent: 20, source: "CATEGORY" });
    expect(bestDiscount({ storeItemDiscountPercent: 150 }, undefined, -5)).toEqual({ percent: 100, source: "ITEM" });
    expect(bestDiscount({ storeItemDiscountPercent: Number.NaN }, undefined, undefined)).toEqual({ percent: 0, source: null });
  });

  it("rounds the line's discount once, half up, to a whole cent", () => {
    expect(percentOf(999, 10)).toBe(100); // 99.9 → 100
    expect(percentOf(5, 10)).toBe(1); // 0.5 → 1
    expect(percentOf(4, 10)).toBe(0); // 0.4 → 0
    expect(percentOf(2, 12.5)).toBe(0); // 0.25 → 0
    expect(percentOf(333, 33.33)).toBe(111); // 110.99 → 111
    expect(percentOf(100_000_000 * 99, 100)).toBe(9_900_000_000);
    // A 3-for line at 333¢ and 10%: 999 × 10% = 99.9 → 100, not 3 × round(33.3) = 99
    const q = priceLines(store({ items: [item("TEA", { storeItemPrices: { USD: 333 }, storeItemDiscountPercent: 10 })] }), [line("TEA", 3)], "USD");
    expect(q.lines[0]).toMatchObject({ subtotalMinor: 999, discountMinor: 100, totalMinor: 899 });
  });

  it("100% off makes a free line; a price of 0 is allowed", () => {
    const q = priceLines(store({ items: [item("TEA", { storeItemDiscountPercent: 100 }), item("FREE", { storeItemPrices: { USD: 0 } })] }), [line("TEA", 2), line("FREE")], "USD");
    expect(q.ok).toBe(true);
    expect(q.totalMinor).toBe(0);
  });

  it("a currency the store doesn't offer fails the whole quote", () => {
    const q = priceLines(store(), [line("TEA")], "EUR");
    expect(q).toMatchObject({ ok: false, lines: [], totalMinor: 0, error: { code: "CURRENCY_NOT_OFFERED" } });
  });

  it.each([
    ["an unknown item", store(), line("NOPE"), "ITEM_NOT_FOUND"],
    ["a hidden item", store({ items: [item("TEA", { storeItemIsActive: false })] }), line("TEA"), "ITEM_NOT_FOUND"],
    ["an item in a hidden category", store({ categoryActive: false }), line("TEA"), "ITEM_NOT_FOUND"],
    ["an item whose category is gone", store({ items: [item("TEA", { storeItemCategoryId: "OLD" })] }), line("TEA"), "ITEM_NOT_FOUND"],
    ["an item not priced in the currency", store({ items: [item("TEA", { storeItemPrices: { AUD: 100 } })] }), line("TEA"), "NOT_SOLD_IN_CURRENCY"],
    ["quantity 0", store(), line("TEA", 0), "INVALID_QUANTITY"],
    ["quantity 1.5", store(), line("TEA", 1.5), "INVALID_QUANTITY"],
    ["quantity 100", store(), line("TEA", 100), "INVALID_QUANTITY"],
    ["a sold-out item", store({ items: [item("TEA", { storeItemStock: 0 })] }), line("TEA"), "OUT_OF_STOCK"],
    ["more than the stock", store({ items: [item("TEA", { storeItemStock: 2 })] }), line("TEA", 3), "INSUFFICIENT_STOCK"],
  ])("%s is a line error that counts for nothing", (_n, s, l, code) => {
    const q = priceLines(s, [l, line("TEA2")], "USD");
    expect(q.lines[0].error?.code).toBe(code);
    expect(q.lines[0].totalMinor).toBe(0);
    expect(q.ok).toBe(false);
  });

  it("other lines are still priced when one has a problem", () => {
    const q = priceLines(store({ items: [item("TEA"), item("CAKE", { storeItemStock: 0 })] }), [line("CAKE"), line("TEA", 2)], "USD");
    expect(q.lines.map((l) => l.error?.code ?? null)).toEqual(["OUT_OF_STOCK", null]);
    expect(q.totalMinor).toBe(2000);
    expect(q.ok).toBe(false);
  });

  it("lines of one item share its stock, in line order (add-ons don't split it)", () => {
    const tea = item("TEA", { storeItemStock: 5, storeItemCustomParams: [extras] });
    const q = priceLines(store({ items: [tea] }), [
      line("TEA", 3, [{ label: "Extras", values: ["Card"] }]),
      line("TEA", 3, [{ label: "Extras", values: ["Wrap"] }]),
      line("TEA", 1),
    ], "USD");
    expect(q.lines.map((l) => l.error?.code ?? null)).toEqual([null, "INSUFFICIENT_STOCK", null]);
    expect(q.lines[1].error?.available).toBe(2);
    expect(q.subtotalMinor).toBe(4000);
    const used = priceLines(store({ items: [tea] }), [line("TEA", 5, [{ label: "Extras", values: ["Card"] }]), line("TEA", 1)], "USD");
    expect(used.lines[1].error).toMatchObject({ code: "OUT_OF_STOCK", available: 0 });
  });

  it("unlimited stock (-1) never runs out", () => {
    expect(priceLines(store(), [line("TEA", 99), line("TEA", 99)], "USD").ok).toBe(true);
  });

  it("an empty cart is not ok, with zero totals", () => {
    expect(priceLines(store(), [], "USD")).toMatchObject({ ok: false, lines: [], totalMinor: 0, error: null });
  });

  it("returns the picks in the item's order and names the item", () => {
    const tea = item("TEA", { storeItemCustomParams: [size, extras], storeItemVariants: sizeRows() });
    const q = priceLines(store({ items: [tea] }), [line("TEA", 1, [{ label: "Extras", values: ["Wrap", "Card"] }, { label: "Size", values: ["M"] }])], "USD");
    expect(q.lines[0]).toMatchObject({ itemName: "TEA", params: [{ label: "Size", values: ["M"] }, { label: "Extras", values: ["Card", "Wrap"] }] });
  });
});

describe("checkParams (4.1)", () => {
  const params = [size, extras];
  const err = (picks: QuoteLineInput["params"], p = params) => {
    const r = checkParams(p, picks);
    return "error" in r ? r.error : null;
  };

  it("accepts valid picks; optional params can be left out; blank picks are ignored", () => {
    expect(err([{ label: "Size", values: ["L"] }])).toBeNull();
    expect(err([{ label: "Size", values: [" M "] }, { label: "Extras", values: [] }])).toBeNull();
  });

  it.each([
    ["a missing mandatory param", [], "MISSING_PARAM", "Size"],
    ["two picks on a single choice", [{ label: "Size", values: ["S", "M"] }], "INVALID_PARAM", "Size"],
    ["an option the param doesn't have", [{ label: "Size", values: ["XL"] }], "INVALID_PARAM", "Size"],
    ["a repeated choice on a multiple choice", [{ label: "Size", values: ["S"] }, { label: "Extras", values: ["Card", "Card"] }], "INVALID_PARAM", "Extras"],
    ["a param the item doesn't have", [{ label: "Size", values: ["S"] }, { label: "Colour", values: ["Red"] }], "INVALID_PARAM", "Colour"],
    ["the same param twice", [{ label: "Size", values: ["S"] }, { label: "Size", values: ["M"] }], "INVALID_PARAM", "Size"],
  ])("refuses %s", (_n, picks, code, param) => {
    expect(err(picks as QuoteLineInput["params"])).toMatchObject({ code, param });
  });

  it("a mandatory param with no real options can't block the line", () => {
    const empty: StoreParameter = { ...size, storeParamLabel: "Engraving", storeParamOptions: ["", " "] };
    expect(err([], [empty])).toBeNull();
  });
});

describe("tax and fulfilment (4.2)", () => {
  const deliver = { deliveryEnabled: true, deliveryFees: { USD: 500, AUD: 900 } };

  it("defaults: pickup only, no tax; total is goods after discount", () => {
    const q = priceLines(store(), [line("TEA", 2)], "USD");
    expect(q).toMatchObject({
      fulfilmentOptions: [{ method: "PICKUP", feeMinor: 0 }],
      fulfilment: "PICKUP",
      deliveryMinor: 0,
      taxPercent: 0,
      taxMinor: 0,
      totalMinor: 2000,
      ok: true,
      error: null,
    });
  });

  it("settings saved before 4.2 price as pickup with no tax", () => {
    const s = store();
    s.settings.general = { pickupAddress: "", discountPercent: 0, isOnline: false };
    expect(priceLines(s, [line("TEA")], "USD")).toMatchObject({ fulfilment: "PICKUP", taxMinor: 0, totalMinor: 1000, ok: true });
  });

  it("delivery adds its fee in the quote's currency; pickup stays the default", () => {
    const s = store({ general: deliver });
    expect(priceLines(s, [line("TEA")], "USD").fulfilmentOptions).toEqual([
      { method: "PICKUP", feeMinor: 0 },
      { method: "DELIVERY", feeMinor: 500 },
    ]);
    expect(priceLines(s, [line("TEA")], "USD")).toMatchObject({ fulfilment: "PICKUP", totalMinor: 1000 });
    expect(priceLines(s, [line("TEA")], "USD", { fulfilment: "DELIVERY" })).toMatchObject({ deliveryMinor: 500, totalMinor: 1500, ok: true });
    expect(priceLines(s, [line("TEA")], "AUD", { fulfilment: "DELIVERY" })).toMatchObject({ deliveryMinor: 900, totalMinor: 2400 });
  });

  it("delivery-only stores default to delivery", () => {
    const q = priceLines(store({ general: { ...deliver, pickupEnabled: false } }), [line("TEA")], "USD");
    expect(q).toMatchObject({ fulfilmentOptions: [{ method: "DELIVERY", feeMinor: 500 }], fulfilment: "DELIVERY", totalMinor: 1500 });
  });

  it("no delivery fee when nothing in the cart can be bought", () => {
    const q = priceLines(store({ general: deliver }), [line("NOPE")], "USD", { fulfilment: "DELIVERY" });
    expect(q).toMatchObject({ deliveryMinor: 0, totalMinor: 0, ok: false });
  });

  it("a method the store doesn't offer: lines priced, quote not ok", () => {
    const q = priceLines(store(), [line("TEA")], "USD", { fulfilment: "DELIVERY" });
    expect(q).toMatchObject({ fulfilment: null, deliveryMinor: 0, totalMinor: 1000, ok: false, error: { code: "FULFILMENT_UNAVAILABLE" } });
    expect(q.lines[0].error).toBeNull();
    // Delivery is on but has no fee in this currency
    const noAud = priceLines(store({ general: { deliveryEnabled: true, deliveryFees: { USD: 500 } } }), [line("TEA")], "AUD", { fulfilment: "DELIVERY" });
    expect(noAud.error?.code).toBe("FULFILMENT_UNAVAILABLE");
    expect(noAud.fulfilmentOptions).toEqual([{ method: "PICKUP", feeMinor: 0 }]);
  });

  it("tax on top: percent of goods after discount plus delivery, rounded once", () => {
    const tea = item("TEA", { storeItemPrices: { USD: 999 }, storeItemDiscountPercent: 10 });
    const q = priceLines(store({ items: [tea], general: { ...deliver, taxPercent: 8.875 } }), [line("TEA", 3)], "USD", { fulfilment: "DELIVERY" });
    // goods 2997 − 300 discount = 2697, + 500 delivery = 3197; 8.875% = 283.73 → 284
    expect(q).toMatchObject({ subtotalMinor: 2997, discountMinor: 300, deliveryMinor: 500, taxMinor: 284, totalMinor: 3481, pricesIncludeTax: false });
  });

  it("tax included: shows the tax inside the total and adds nothing", () => {
    const q = priceLines(store({ general: { taxPercent: 10, pricesIncludeTax: true } }), [line("TEA", 11)], "USD");
    // 11000 includes 10% GST: 11000 × 10 / 110 = 1000
    expect(q).toMatchObject({ taxMinor: 1000, totalMinor: 11000, pricesIncludeTax: true });
    expect(includedTaxOf(1000, 10)).toBe(91); // 90.909 → 91
    expect(includedTaxOf(1001, 15)).toBe(131); // 130.565 → 131
    expect(includedTaxOf(1000, 0)).toBe(0);
  });
});

describe("priceLines Canadian tax (4.4)", () => {
  const canada = (patch: object = {}) =>
    store({
      general: {
        taxMode: "CANADA",
        pickupEnabled: true,
        deliveryEnabled: true,
        deliveryFees: { USD: 500, AUD: 500 },
        canadaTax: { homeProvince: "ON", gstRegistered: true, provincialRegistrations: ["BC", "QC"], ...patch },
      },
    });

  it("pickup is taxed in the store's province", () => {
    const q = priceLines(canada(), [line("TEA", 2)], "USD", { fulfilment: "PICKUP" });
    expect(q.taxRegion).toEqual({ province: "ON", name: "Ontario" });
    expect(q.taxLines).toEqual([{ code: "HST", label: "HST", percent: 13, minor: 260 }]);
    expect(q).toMatchObject({ taxMinor: 260, taxPercent: 13, totalMinor: 2260, ok: true, error: null });
  });

  it("delivery is taxed in the shopper's province, with each part rounded on its own", () => {
    // 2000 goods + 500 delivery = 2500 taxable
    const bc = priceLines(canada(), [line("TEA", 2)], "USD", { fulfilment: "DELIVERY", postalCode: "v6b 1a1" });
    expect(bc.taxLines.map((l) => [l.label, l.minor])).toEqual([["GST", 125], ["PST", 175]]);
    expect(bc).toMatchObject({ taxMinor: 300, totalMinor: 2800, ok: true });
    const qc = priceLines(canada(), [line("TEA", 2)], "USD", { fulfilment: "DELIVERY", postalCode: "H2X1Y4" });
    expect(qc.taxLines.map((l) => [l.label, l.minor])).toEqual([["GST", 125], ["QST", 249]]); // 249.375
    expect(qc.taxPercent).toBe(14.975);
    // Not registered for Saskatchewan's PST: GST only
    const sk = priceLines(canada(), [line("TEA", 2)], "USD", { fulfilment: "DELIVERY", postalCode: "S4P 3Y2" });
    expect(sk.taxLines.map((l) => l.label)).toEqual(["GST"]);
  });

  it("a delivery needs a valid Canadian postal code before tax is known", () => {
    const missing = priceLines(canada(), [line("TEA")], "USD", { fulfilment: "DELIVERY" });
    expect(missing).toMatchObject({ taxMinor: 0, taxLines: [], ok: false, error: { code: "POSTAL_CODE_REQUIRED" } });
    expect(missing.lines[0].error).toBeNull();
    const bad = priceLines(canada(), [line("TEA")], "USD", { fulfilment: "DELIVERY", postalCode: "90210" });
    expect(bad).toMatchObject({ ok: false, error: { code: "INVALID_POSTAL_CODE" } });
  });

  it("a store that charges no tax needs no postal code", () => {
    const q = priceLines(canada({ gstRegistered: false, provincialRegistrations: [] }), [line("TEA")], "USD", { fulfilment: "DELIVERY" });
    expect(q).toMatchObject({ taxMinor: 0, taxLines: [], ok: true, error: null });
  });

  it("ignores the flat rate and 'prices include tax' in Canada mode, and keeps flat mode as before", () => {
    const s = canada();
    s.settings.general = { ...s.settings.general, taxPercent: 20 };
    expect(priceLines(s, [line("TEA")], "USD", { fulfilment: "PICKUP" }).taxMinor).toBe(130);
    const flat = priceLines(store({ general: { taxPercent: 10 } }), [line("TEA")], "USD");
    expect(flat.taxLines).toEqual([{ code: "TAX", label: "Tax", percent: 10, minor: 100 }]);
    expect(flat.taxRegion).toBeNull();
  });

  it("percentOf keeps thousandths of a percent and big carts exact", () => {
    expect(percentOf(10000, 9.975)).toBe(998); // 997.5 rounds half up
    expect(percentOf(100_000_000 * 99 * 50, 30)).toBe(148_500_000_000);
  });
});
