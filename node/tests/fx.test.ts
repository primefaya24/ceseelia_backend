import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import {
  appliedFx,
  convertMinor,
  currentFxRates,
  effectivePrices,
  FxRates,
  mainCurrency,
  setFxRates,
} from "../layers/core/fx";
import { withEffectiveDeliveryFees, withEffectiveItemPrices } from "../layers/core/fx/inventory";
import { fetchFxRates, FX_KEY, refreshFxRates } from "../layers/core/fx/refresh";
import { toPublicInventory } from "../layers/aws/dynamodb/dynamo-entities/store";
import { priceLines } from "../layers/core/pricing";
import { initStoreCategory, StoreItem, StoreSettings } from "../layers/core/interfaces/store";
import { liveStoreSettings } from "./fixtures";

const RATES: FxRates = { date: "2026-11-23", rates: { USD: 1, CAD: 1.4, AUD: 1.5 } };
const cur = (code: string, main = false, rounding?: string) =>
  ({ currencyCode: code, currencySign: "$", currencyFloat: "LEFT", currencyIsDefault: main, ...(rounding ? { currencyRounding: rounding } : {}) }) as any;

afterEach(() => setFxRates(null));

describe("convertMinor (T.4c)", () => {
  it("converts at the rate and rounds each way", () => {
    expect(convertMinor(2500, "USD", "CAD", RATES, "EXACT")).toBe(3500);
    expect(convertMinor(1234, "USD", "CAD", RATES, "EXACT")).toBe(1728); // 17.276
    expect(convertMinor(1234, "USD", "CAD", RATES, "WHOLE")).toBe(1700);
    expect(convertMinor(1234, "USD", "CAD", RATES, "NINETY_NINE")).toBe(1699);
    expect(convertMinor(1290, "USD", "CAD", RATES, "NINETY_NINE")).toBe(1799); // 18.06 → 17.99
    expect(convertMinor(3500, "CAD", "USD", RATES, "EXACT")).toBe(2500);
    expect(convertMinor(3500, "CAD", "AUD", RATES, "EXACT")).toBe(3750);
  });

  it("free stays free; a small price never becomes 0; no rate = null", () => {
    expect(convertMinor(0, "USD", "CAD", RATES, "NINETY_NINE")).toBe(0);
    expect(convertMinor(10, "USD", "CAD", RATES, "NINETY_NINE")).toBe(99);
    expect(convertMinor(10, "USD", "CAD", RATES, "WHOLE")).toBe(100);
    expect(convertMinor(1, "USD", "CAD", RATES, "EXACT")).toBe(1);
    expect(convertMinor(100, "USD", "CAD", null)).toBeNull();
    expect(convertMinor(100, "USD", "EUR", RATES)).toBeNull();
    expect(convertMinor(100, "USD", "USD", null)).toBe(100);
  });
});

describe("effectivePrices (T.4d)", () => {
  const currencies = [cur("CAD", true), cur("USD", false, "EXACT"), cur("AUD")];

  it("fills every offered currency from the main price; a price set by hand wins", () => {
    expect(effectivePrices({ CAD: 1400 }, currencies, RATES)).toEqual({
      prices: { CAD: 1400, USD: 1000, AUD: 1499 },
      auto: ["USD", "AUD"],
    });
    expect(effectivePrices({ CAD: 1400, USD: 1200 }, currencies, RATES).prices.USD).toBe(1200);
  });

  it("an item with no main-currency price converts from its first set price", () => {
    // Her case: prices in USD, then CAD made the main currency without converting.
    expect(effectivePrices({ USD: 2500 }, currencies, RATES).prices).toEqual({ USD: 2500, CAD: 3499, AUD: 3799 });
  });

  it("without rates nothing is converted", () => {
    expect(effectivePrices({ CAD: 1400 }, currencies, null)).toEqual({ prices: { CAD: 1400 }, auto: [] });
    expect(effectivePrices({}, currencies, RATES)).toEqual({ prices: {}, auto: [] });
  });

  it("the main currency is the default one, else the first", () => {
    expect(mainCurrency(currencies)).toBe("CAD");
    expect(mainCurrency([cur("AUD"), cur("USD")])).toBe("AUD");
    expect(mainCurrency([])).toBeNull();
  });
});

describe("items, variant rows and delivery fees (T.4d)", () => {
  const currencies = [cur("CAD", true), cur("USD", false, "EXACT")];

  it("variant rows are filled and the item's price is its sold rows' lowest", () => {
    const item = {
      storeItemPrices: { CAD: 1400 },
      storeItemVariants: [
        { storeVariantOptions: { Size: "S" }, storeVariantStock: 1, storeVariantPrices: { CAD: 1400 }, storeVariantIsActive: true },
        { storeVariantOptions: { Size: "L" }, storeVariantStock: 1, storeVariantPrices: { CAD: 2800, USD: 1500 }, storeVariantIsActive: true },
        { storeVariantOptions: { Size: "XL" }, storeVariantStock: 1, storeVariantPrices: { CAD: 700 }, storeVariantIsActive: false },
      ],
    } as unknown as StoreItem;
    const out = withEffectiveItemPrices(item, currencies, RATES);
    expect(out.storeItemVariants.map((v) => v.storeVariantPrices)).toEqual([
      { CAD: 1400, USD: 1000 },
      { CAD: 2800, USD: 1500 },
      { CAD: 700, USD: 500 },
    ]);
    expect(out.storeItemPrices).toEqual({ CAD: 1400, USD: 1000 });
  });

  it("delivery fees follow the main one; none set stays none", () => {
    const s = { currencies, general: { deliveryFees: { CAD: 700 } } } as any;
    expect(withEffectiveDeliveryFees(s, RATES).general.deliveryFees).toEqual({ CAD: 700, USD: 500 });
    const none = { currencies, general: { deliveryFees: {} } } as any;
    expect(withEffectiveDeliveryFees(none, RATES)).toBe(none);
  });
});

describe("storefront and quote with automatic prices (T.4d / T.4e)", () => {
  const settings = (): StoreSettings => {
    const s = liveStoreSettings() as StoreSettings;
    s.currencies = [cur("CAD", true), cur("USD", false, "EXACT")];
    s.general = { ...s.general, pickupEnabled: true, deliveryEnabled: true, deliveryFees: { CAD: 700 } };
    return s;
  };
  const data = () => ({
    settings: settings(),
    categories: [{ ...initStoreCategory("C1", "Tea"), storeCategoriyId: "C1", storeCategoryIsActive: true }],
    items: [
      {
        storeItemId: "I1",
        storeItemName: "Tea",
        storeItemCategoryId: "C1",
        storeItemIsActive: true,
        storeItemStock: -1,
        storeItemCustomParams: [],
        storeItemVariants: [],
        storeItemPrices: { CAD: 1400 },
      } as unknown as StoreItem,
    ],
  });

  it("the storefront gets prices and fees in every offered currency", () => {
    setFxRates(RATES);
    const pub = toPublicInventory(data());
    expect(pub.items[0].storeItemPrices).toEqual({ CAD: 1400, USD: 1000 });
    expect(pub.settings.general.deliveryFees).toEqual({ CAD: 700, USD: 500 });
  });

  it("without rates the item sells only where it's priced (as before Stage T)", () => {
    const pub = toPublicInventory(data());
    expect(pub.items[0].storeItemPrices).toEqual({ CAD: 1400 });
  });

  it("a quote in the other currency charges the converted price and records the rate", () => {
    setFxRates(RATES);
    const q = priceLines(toPublicInventory(data()), [{ itemId: "I1", quantity: 2, params: [] }], "USD", { fulfilment: "DELIVERY" });
    expect(q.ok).toBe(true);
    expect(q.subtotalMinor).toBe(2000);
    expect(q.deliveryMinor).toBe(500);
    expect(q.fx).toEqual({ from: "CAD", to: "USD", rate: 0.714286, date: "2026-11-23" });
    const main = priceLines(toPublicInventory(data()), [{ itemId: "I1", quantity: 1, params: [] }], "CAD", {});
    expect(main.fx).toBeUndefined();
  });

  it("appliedFx: none in the main currency or without rates", () => {
    expect(appliedFx([cur("CAD", true)], "CAD", RATES)).toBeNull();
    expect(appliedFx([cur("CAD", true)], "USD", null)).toBeNull();
  });
});

describe("refreshFxRates (T.4a)", () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const ok = (body: unknown) => vi.fn().mockResolvedValue({ ok: true, json: async () => body }) as unknown as typeof fetch;
  const source = { amount: 1, base: "USD", date: "2026-11-23", rates: { CAD: 1.4, AUD: 1.5 } };
  beforeEach(() => {
    ddb.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("parses the source; anything unexpected is null", async () => {
    expect(await fetchFxRates(ok(source))).toEqual(RATES);
    expect(await fetchFxRates(ok({ ...source, base: "EUR" }))).toBeNull();
    expect(await fetchFxRates(ok({ ...source, rates: { CAD: 1.4 } }))).toBeNull();
    expect(await fetchFxRates(vi.fn().mockRejectedValue(new Error("down")) as unknown as typeof fetch)).toBeNull();
    expect(await fetchFxRates(vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch)).toBeNull();
  });

  it("a fresh row is used without fetching", async () => {
    const now = Date.UTC(2026, 10, 23, 12);
    ddb.on(GetCommand).resolves({ Item: { ...FX_KEY, ...RATES, fetchedAt: now - 60_000 } });
    const fetchFn = ok(source);
    await refreshFxRates(now, fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(currentFxRates()).toEqual(RATES);
  });

  it("an old or missing row is refreshed and saved", async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    await refreshFxRates(1_000, ok(source));
    expect(currentFxRates()).toEqual(RATES);
    expect(ddb.commandCalls(PutCommand)[0].args[0].input.Item).toMatchObject({ ...FX_KEY, ...RATES, fetchedAt: 1_000 });
  });

  it("a failed fetch keeps the last rates", async () => {
    const old = { date: "2026-11-20", rates: { USD: 1, CAD: 1.3, AUD: 1.4 } };
    ddb.on(GetCommand).resolves({ Item: { ...FX_KEY, ...old, fetchedAt: 0 } });
    await refreshFxRates(13 * 60 * 60 * 1000, vi.fn().mockRejectedValue(new Error("down")) as unknown as typeof fetch);
    expect(currentFxRates()).toEqual(old);
  });
});
