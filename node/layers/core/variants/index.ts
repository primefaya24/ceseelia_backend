import { MAX_COUNT, NUMBER_RANGE, STOCK_UNLIMITED } from "../../../constants/input-limits";
import type { StoreItem, StoreItemPrices, StoreItemVariant, StoreParameter } from "../interfaces/store";

/*
 * Variants: stock and price per option combination (progress.md 2.7).
 *
 *   - A single-choice param with at least one option is a *variant param* (Size, Color). An item
 *     with any variant params has a row in `storeItemVariants` for every combination of their
 *     options (Size × Color): its own stock, its own price per currency, and whether it's sold
 *     at all ("we don't make XS in Red"). Variant params are always required.
 *   - Multiple-choice params are *add-ons* (gift wrap, card): picked freely, optional or
 *     required, and they never change stock or price.
 *   - An item with no variant params keeps one stock and one price per currency, as before.
 *   - For a variant item, `storeItemStock` and `storeItemPrices` are worked out from the rows on
 *     every save (`withVariantTotals`): the stock is the sum of the sold rows (-1 if any is
 *     unlimited) and each currency's price is the lowest sold row's ("From $12"). The storefront
 *     list, sold-out filtering and currency filtering keep using them; buying uses the row.
 *   - Rows are matched by option labels ({ Size: "M", Color: "White" }), so labels are unique
 *     per item (params) and per param (options). The editor keeps rows through renames.
 *
 * The webapp mirrors these rules in `core/functions/variant.functions.ts`; keep them in step.
 */

/** The most rows (combinations) one item may have; also keeps an item well under 400 KB. */
export const MAX_VARIANTS = MAX_COUNT.itemVariants;

const clean = (s: string): string => (typeof s === "string" ? s.trim() : "");

/** A param's real options (trimmed, blanks dropped). */
export const paramOptionList = (p: StoreParameter): string[] =>
  (p.storeParamOptions ?? []).map(clean).filter((o) => o.length > 0);

/** The params that make variants: single choice, with options. In the item's param order. */
export function variantParams(params: StoreParameter[] | undefined): StoreParameter[] {
  return (params ?? []).filter((p) => p.storeParamType !== "MULTI_SELECT" && paramOptionList(p).length > 0);
}

export const hasVariants = (item: Pick<StoreItem, "storeItemCustomParams">): boolean =>
  variantParams(item.storeItemCustomParams).length > 0;

/** How many rows the params make (product of option counts; 0 when there are no variant params). */
export function combinationCount(params: StoreParameter[] | undefined): number {
  const vp = variantParams(params);
  if (vp.length === 0) return 0;
  return vp.reduce((n, p) => n * paramOptionList(p).length, 1);
}

/** Every combination, in param and option order (Size S/Black, S/White, M/Black…). Capped. */
export function variantCombinations(params: StoreParameter[] | undefined): Record<string, string>[] {
  const vp = variantParams(params);
  if (vp.length === 0 || combinationCount(params) > MAX_VARIANTS) return [];
  let combos: Record<string, string>[] = [{}];
  for (const p of vp) {
    const next: Record<string, string>[] = [];
    for (const combo of combos) {
      for (const option of paramOptionList(p)) next.push({ ...combo, [clean(p.storeParamLabel)]: option });
    }
    combos = next;
  }
  return combos;
}

/** A stable key for a combination: its options in variant-param order. */
export function variantKey(params: StoreParameter[] | undefined, options: Record<string, string>): string {
  return JSON.stringify(variantParams(params).map((p) => options?.[clean(p.storeParamLabel)] ?? null));
}

/** The row for these options, if any. `options` may hold more labels (add-ons); they're ignored. */
export function findVariant(
  item: Pick<StoreItem, "storeItemCustomParams" | "storeItemVariants">,
  options: Record<string, string>
): StoreItemVariant | undefined {
  const params = item.storeItemCustomParams;
  const key = variantKey(params, options);
  return (item.storeItemVariants ?? []).find((v) => variantKey(params, v.storeVariantOptions) === key);
}

/**
 * Whether the item can be sold as it is: no variant params, or a row for every combination.
 * Items saved before variants (single-choice params, no rows) aren't, until the merchant fills
 * in the table; the storefront leaves them out.
 */
export function variantsReady(item: Pick<StoreItem, "storeItemCustomParams" | "storeItemVariants">): boolean {
  const combos = variantCombinations(item.storeItemCustomParams);
  if (!hasVariants(item)) return true;
  if (combos.length === 0) return false; // over the cap
  return combos.every((c) => findVariant(item, c) !== undefined);
}

/** Stock and "from" prices of the sold rows (see the header). */
export function variantTotals(variants: StoreItemVariant[]): { stock: number; prices: StoreItemPrices } {
  const sold = variants.filter((v) => v.storeVariantIsActive);
  let stock = 0;
  const prices: StoreItemPrices = {};
  for (const v of sold) {
    if (stock !== STOCK_UNLIMITED) {
      stock = v.storeVariantStock === STOCK_UNLIMITED ? STOCK_UNLIMITED : stock + Math.max(0, v.storeVariantStock);
    }
    for (const [code, cents] of Object.entries(v.storeVariantPrices ?? {})) {
      const c = code as keyof StoreItemPrices;
      if (typeof cents === "number" && (prices[c] === undefined || cents < (prices[c] as number))) prices[c] = cents;
    }
  }
  return { stock: stock === STOCK_UNLIMITED ? stock : Math.min(stock, NUMBER_RANGE.stock.max), prices };
}

/**
 * The item as it should be saved: labels and options trimmed, variant params required, rows in
 * combination order (unknown rows dropped), and for a variant item the stock and prices worked
 * out from the rows. An item without variant params gets no rows. Doesn't validate.
 */
export function withVariantTotals(item: StoreItem): StoreItem {
  const params = (item.storeItemCustomParams ?? []).map((p) => {
    const isVariant = p.storeParamType !== "MULTI_SELECT" && paramOptionList(p).length > 0;
    return {
      ...p,
      storeParamLabel: clean(p.storeParamLabel),
      storeParamOptions: (p.storeParamOptions ?? []).map(clean),
      storeParamIsMandatory: isVariant ? true : p.storeParamIsMandatory,
    };
  });
  const base: StoreItem = { ...item, storeItemCustomParams: params };
  if (variantParams(params).length === 0) return { ...base, storeItemVariants: [] };
  const rows = (item.storeItemVariants ?? []).map((v) => ({
    ...v,
    storeVariantOptions: Object.fromEntries(
      Object.entries(v.storeVariantOptions ?? {}).map(([k, o]) => [clean(k), clean(o)])
    ),
  }));
  const ordered: StoreItemVariant[] = [];
  for (const combo of variantCombinations(params)) {
    const row = findVariant({ storeItemCustomParams: params, storeItemVariants: rows }, combo);
    if (row) ordered.push({ ...row, storeVariantOptions: combo });
  }
  // Over the cap there are no combinations: keep the rows as sent so validation can refuse them.
  const variants = variantCombinations(params).length > 0 ? ordered : rows;
  const totals = variantTotals(variants);
  return { ...base, storeItemVariants: variants, storeItemStock: totals.stock, storeItemPrices: totals.prices };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Type checks for one row. */
export function isStoreItemVariantPure(v: unknown): boolean {
  if (!isObject(v)) return false;
  const r = v as unknown as StoreItemVariant;
  return (
    isObject(r.storeVariantOptions) &&
    Object.values(r.storeVariantOptions).every((o) => typeof o === "string") &&
    typeof r.storeVariantStock === "number" &&
    isObject(r.storeVariantPrices) &&
    Object.values(r.storeVariantPrices).every((p) => typeof p === "number") &&
    typeof r.storeVariantIsActive === "boolean"
  );
}

/**
 * Value checks for a saved item's params and rows (after withVariantTotals). Param labels are
 * unique, and so are each param's options. With variant params: at most MAX_VARIANTS
 * combinations, exactly one row per combination, every stock -1 or 0..max, and every sold row
 * priced in at least one currency (`pricesOk` checks a row's prices). Without: no rows.
 */
export function areVariantsValid(item: StoreItem, pricesOk: (p: StoreItemPrices) => boolean): boolean {
  const params = item.storeItemCustomParams ?? [];
  const labels = params.map((p) => clean(p.storeParamLabel));
  if (new Set(labels).size !== labels.length) return false;
  if (params.some((p) => new Set(paramOptionList(p)).size !== paramOptionList(p).length)) return false;
  const rows = item.storeItemVariants ?? [];
  if (!hasVariants(item)) return rows.length === 0;
  const combos = variantCombinations(params);
  if (combos.length === 0 || rows.length !== combos.length || rows.length > MAX_VARIANTS) return false;
  const keys = new Set(rows.map((r) => variantKey(params, r.storeVariantOptions)));
  if (keys.size !== combos.length || !combos.every((c) => keys.has(variantKey(params, c)))) return false;
  const vpLabels = variantParams(params).map((p) => clean(p.storeParamLabel));
  return (
    rows.some((r) => r.storeVariantIsActive) &&
    rows.every(
      (r) =>
        Object.keys(r.storeVariantOptions).length === vpLabels.length &&
        Number.isInteger(r.storeVariantStock) &&
        r.storeVariantStock >= NUMBER_RANGE.stock.min &&
        r.storeVariantStock <= NUMBER_RANGE.stock.max &&
        // A row that isn't sold may have no prices; any prices it has must still be valid.
        (Object.keys(r.storeVariantPrices).length === 0 ? !r.storeVariantIsActive : pricesOk(r.storeVariantPrices))
    )
  );
}

/** Rows a shopper may see: sold ones only, prices cut to the offered currencies. */
export function publicVariants(variants: StoreItemVariant[] | undefined, offered: Set<string>): StoreItemVariant[] {
  return (variants ?? [])
    .filter((v) => v.storeVariantIsActive)
    .map((v) => ({
      ...v,
      storeVariantPrices: Object.fromEntries(
        Object.entries(v.storeVariantPrices ?? {}).filter(([code]) => offered.has(code))
      ) as StoreItemPrices,
    }));
}
