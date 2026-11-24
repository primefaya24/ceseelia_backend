/*
 * T.5: change a store's main currency.
 *
 *   KEEP_NUMBERS ("my prices were really in CAD"): every price in the old main currency moves to
 *     the new one with the same number (34.99 USD → 34.99 CAD), on items, variant rows and the
 *     delivery fees. The old currency stays offered, now automatic (converted from the new
 *     prices). A price already set by hand in the new currency is replaced.
 *   CONVERT: the new currency becomes the main one. A price set by hand in it is kept; the others
 *     are worked out at today's rate (with the new currency's rounding) and stored. Prices set by
 *     hand in other currencies, the old main one included, stay as they are.
 *
 * The new currency is added when it isn't offered yet. Items are written first (each one only if
 * unchanged since it was read, retried), then the settings, so a failure part-way can be run
 * again: items already moved are skipped.
 */
import { StoreItem, StoreItemPrices, StoreSettings, initStoreCurrency } from "../interfaces/store";
import { variantTotals } from "../variants";
import { convertMinor, CurrencyRounding, DEFAULT_ROUNDING, FxRates, isCurrencyRounding, mainCurrency } from ".";

export const MAIN_CURRENCY_MODES = ["KEEP_NUMBERS", "CONVERT"] as const;
export type MainCurrencyMode = (typeof MAIN_CURRENCY_MODES)[number];

type Prices = Partial<Record<string, number>>;

/** One price list moved to the new main currency; null when nothing changes. */
export function movePrices(
  prices: Prices | undefined,
  from: string,
  to: string,
  mode: MainCurrencyMode,
  rates: FxRates | null,
  rounding: CurrencyRounding
): Prices | null {
  const p: Prices = { ...(prices ?? {}) };
  const old = p[from];
  if (mode === "KEEP_NUMBERS") {
    if (typeof old !== "number") return null;
    p[to] = old;
    delete p[from];
    return p;
  }
  if (typeof p[to] === "number" || typeof old !== "number") return null;
  const converted = convertMinor(old, from, to, rates, rounding);
  if (converted === null) return null;
  p[to] = converted;
  return p;
}

/** The item with its prices moved; the same object when nothing changes. */
export function moveItemPrices(
  item: StoreItem,
  from: string,
  to: string,
  mode: MainCurrencyMode,
  rates: FxRates | null,
  rounding: CurrencyRounding
): StoreItem {
  const rows = item.storeItemVariants ?? [];
  if (rows.length > 0) {
    let changed = false;
    const moved = rows.map((v) => {
      const next = movePrices(v.storeVariantPrices, from, to, mode, rates, rounding);
      if (!next) return v;
      changed = true;
      return { ...v, storeVariantPrices: next as StoreItemPrices };
    });
    if (!changed) return item;
    return { ...item, storeItemVariants: moved, storeItemPrices: variantTotals(moved).prices };
  }
  const next = movePrices(item.storeItemPrices, from, to, mode, rates, rounding);
  return next ? { ...item, storeItemPrices: next as StoreItemPrices } : item;
}

/** The settings' currencies with `to` as the main one (added when missing) and the fees moved. */
export function moveSettings(
  settings: Pick<StoreSettings, "currencies" | "general">,
  to: string,
  mode: MainCurrencyMode,
  rates: FxRates | null
): Pick<StoreSettings, "currencies" | "general"> {
  const from = mainCurrency(settings.currencies);
  const has = settings.currencies.some((c) => c.currencyCode === to);
  const currencies = (has ? settings.currencies : [...settings.currencies, initStoreCurrency(to)]).map((c) => ({
    ...c,
    currencyIsDefault: c.currencyCode === to,
  }));
  const fees = settings.general?.deliveryFees;
  const moved = from && fees ? movePrices(fees, from, to, mode, rates, roundingFor(settings.currencies, to)) : null;
  return {
    currencies,
    general: moved ? { ...settings.general, deliveryFees: moved as StoreItemPrices } : settings.general,
  };
}

/** The rounding automatic prices in `code` used (what a frozen converted price keeps). */
export function roundingFor(currencies: StoreSettings["currencies"], code: string): CurrencyRounding {
  const r = currencies.find((c) => c.currencyCode === code)?.currencyRounding;
  return isCurrencyRounding(r) ? r : DEFAULT_ROUNDING;
}
