import { MAX_QUANTITY_PER_LINE } from "../../../constants/input-limits";
import {
  isUnlimitedStock,
  StoreCategory,
  StoreItem,
  StoreParameter,
  StoreSettings,
} from "../interfaces/store";

/*
 * The one pricing function (progress.md 4.1). `POST /customer/quote` (4.3) and order creation
 * (5.4) both call it, so the price a shopper sees is the price they're charged. It's pure: the
 * caller loads the store and passes it in. Money is whole minor units (cents) throughout.
 *
 * Rules:
 *   - Discount: the biggest of the item's, its category's and the store's (`general`) percent.
 *     They don't stack (decided 2026-11-09; the storefront badge shows the same number).
 *   - Rounding: a line's discount is worked out on the whole line (unit × qty) and rounded to
 *     the nearest cent, half up, so a line never drifts by a cent per unit.
 *   - A line with a problem gets an `error` and counts for nothing; the rest are still priced,
 *     so the cart can show what to fix. `ok` is true only when every line is fine.
 *   - Stock is shared: two lines of one item (different options) draw on the same stock, in
 *     line order.
 *   - Tax and delivery are 4.2; `totalMinor` is subtotal minus discount until then.
 */

export interface QuoteLineInput {
  itemId: string;
  quantity: number;
  params: { label: string; values: string[] }[];
}

export type LineErrorCode =
  | "ITEM_NOT_FOUND"
  | "NOT_SOLD_IN_CURRENCY"
  | "INVALID_QUANTITY"
  | "OUT_OF_STOCK"
  | "INSUFFICIENT_STOCK"
  | "MISSING_PARAM"
  | "INVALID_PARAM";

export interface LineError {
  code: LineErrorCode;
  message: string;
  /** INSUFFICIENT_STOCK: how many are left for this line. */
  available?: number;
  /** MISSING_PARAM / INVALID_PARAM: the param's label. */
  param?: string;
}

export type DiscountSource = "ITEM" | "CATEGORY" | "STORE";

export interface PricedLine {
  index: number;
  itemId: string;
  itemName: string;
  quantity: number;
  /** The picks, in the item's param and option order. */
  params: { label: string; values: string[] }[];
  unitPriceMinor: number;
  discountPercent: number;
  discountSource: DiscountSource | null;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  error: LineError | null;
}

export interface Quote {
  currency: string;
  lines: PricedLine[];
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  ok: boolean;
  /** Whole-quote problem (the lines are then empty). */
  error: { code: "CURRENCY_NOT_OFFERED"; message: string } | null;
}

export interface PricingStore {
  settings: Pick<StoreSettings, "currencies" | "general">;
  categories: StoreCategory[];
  items: StoreItem[];
}

const paramOptions = (p: StoreParameter) =>
  (p.storeParamOptions ?? []).map((o) => o.trim()).filter((o) => o.length > 0);

/** The best discount and where it comes from; ties go to the most specific (item, then category). */
export function bestDiscount(
  item: Pick<StoreItem, "storeItemDiscountPercent">,
  category: Pick<StoreCategory, "storeCategoryDiscountPercent"> | undefined,
  storePercent: number | undefined
): { percent: number; source: DiscountSource | null } {
  const candidates: [number, DiscountSource][] = [
    [item.storeItemDiscountPercent, "ITEM"],
    [category?.storeCategoryDiscountPercent ?? 0, "CATEGORY"],
    [storePercent ?? 0, "STORE"],
  ];
  let best: { percent: number; source: DiscountSource | null } = { percent: 0, source: null };
  for (const [raw, source] of candidates) {
    const percent = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0;
    if (percent > best.percent) best = { percent, source };
  }
  return best;
}

/** `amount × percent / 100`, rounded half up to a whole cent. */
export function percentOf(amountMinor: number, percent: number): number {
  // Work in hundredths of a percent as integers, so 12.5% of 2 cents isn't lost to float error.
  const bp = Math.round(percent * 100);
  return Math.floor((amountMinor * bp + 5000) / 10000);
}

/**
 * Check one line's picks against the item's params. Returns the picks in the item's order, or
 * the first problem: an unknown param or option, two picks on a single choice, a duplicate, or a
 * mandatory param with nothing picked.
 */
export function checkParams(
  itemParams: StoreParameter[],
  picks: QuoteLineInput["params"]
): { params: QuoteLineInput["params"] } | { error: LineError } {
  const byLabel = new Map<string, string[]>();
  for (const pick of picks) {
    const values = pick.values.map((v) => v.trim()).filter((v) => v.length > 0);
    if (values.length === 0) continue;
    if (byLabel.has(pick.label)) {
      return { error: { code: "INVALID_PARAM", message: `"${pick.label}" was given twice.`, param: pick.label } };
    }
    byLabel.set(pick.label, values);
  }
  const known = new Set(itemParams.map((p) => p.storeParamLabel));
  for (const label of byLabel.keys()) {
    if (!known.has(label)) {
      return { error: { code: "INVALID_PARAM", message: `This item has no "${label}" option.`, param: label } };
    }
  }
  const params: QuoteLineInput["params"] = [];
  for (const p of itemParams) {
    const options = paramOptions(p);
    const picked = byLabel.get(p.storeParamLabel) ?? [];
    if (picked.length === 0) {
      if (p.storeParamIsMandatory && options.length > 0) {
        return { error: { code: "MISSING_PARAM", message: `Choose ${p.storeParamLabel}.`, param: p.storeParamLabel } };
      }
      continue;
    }
    if (new Set(picked).size !== picked.length) {
      return { error: { code: "INVALID_PARAM", message: `"${p.storeParamLabel}" has a repeated choice.`, param: p.storeParamLabel } };
    }
    if (p.storeParamType !== "MULTI_SELECT" && picked.length > 1) {
      return { error: { code: "INVALID_PARAM", message: `Choose one ${p.storeParamLabel}.`, param: p.storeParamLabel } };
    }
    const unknown = picked.find((v) => !options.includes(v));
    if (unknown !== undefined) {
      return {
        error: { code: "INVALID_PARAM", message: `"${unknown}" isn't a ${p.storeParamLabel} option.`, param: p.storeParamLabel },
      };
    }
    params.push({ label: p.storeParamLabel, values: options.filter((o) => picked.includes(o)) });
  }
  return { params };
}

export function priceLines(store: PricingStore, lines: QuoteLineInput[], currency: string): Quote {
  const empty = { currency, lines: [], subtotalMinor: 0, discountMinor: 0, totalMinor: 0 };
  if (!store.settings.currencies.some((c) => c.currencyCode === currency)) {
    return { ...empty, ok: false, error: { code: "CURRENCY_NOT_OFFERED", message: `This store doesn't sell in ${currency}.` } };
  }
  const items = new Map(store.items.map((i) => [i.storeItemId, i]));
  const categories = new Map(store.categories.map((c) => [c.storeCategoriyId, c]));
  /** Tracked stock left per item as lines draw on it. */
  const stockLeft = new Map<string, number>();

  const priced = lines.map((line, index): PricedLine => {
    const item = items.get(line.itemId);
    const category = item ? categories.get(item.storeItemCategoryId) : undefined;
    const base: PricedLine = {
      index,
      itemId: line.itemId,
      itemName: item?.storeItemName ?? "",
      quantity: line.quantity,
      params: [],
      unitPriceMinor: 0,
      discountPercent: 0,
      discountSource: null,
      subtotalMinor: 0,
      discountMinor: 0,
      totalMinor: 0,
      error: null,
    };
    const fail = (error: LineError): PricedLine => ({ ...base, error });

    if (!item || !item.storeItemIsActive || !category || !category.storeCategoryIsActive) {
      return fail({ code: "ITEM_NOT_FOUND", message: "This item is no longer available." });
    }
    const unit = item.storeItemPrices?.[currency as keyof typeof item.storeItemPrices];
    if (!Number.isInteger(unit) || (unit as number) < 0) {
      return fail({ code: "NOT_SOLD_IN_CURRENCY", message: `This item isn't sold in ${currency}.` });
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QUANTITY_PER_LINE) {
      return fail({ code: "INVALID_QUANTITY", message: `Choose a quantity from 1 to ${MAX_QUANTITY_PER_LINE}.` });
    }
    const checked = checkParams(item.storeItemCustomParams ?? [], line.params ?? []);
    if ("error" in checked) return fail(checked.error);

    if (!isUnlimitedStock(item.storeItemStock)) {
      const left = stockLeft.get(item.storeItemId) ?? Math.max(0, item.storeItemStock);
      if (left === 0) {
        return fail({ code: "OUT_OF_STOCK", message: "Sold out.", available: 0 });
      }
      if (line.quantity > left) {
        return fail({ code: "INSUFFICIENT_STOCK", message: `Only ${left} left.`, available: left });
      }
      stockLeft.set(item.storeItemId, left - line.quantity);
    }

    const { percent, source } = bestDiscount(item, category, store.settings.general?.discountPercent);
    const subtotalMinor = (unit as number) * line.quantity;
    const discountMinor = percentOf(subtotalMinor, percent);
    return {
      ...base,
      params: checked.params,
      unitPriceMinor: unit as number,
      discountPercent: percent,
      discountSource: source,
      subtotalMinor,
      discountMinor,
      totalMinor: subtotalMinor - discountMinor,
    };
  });

  const valid = priced.filter((l) => !l.error);
  const subtotalMinor = valid.reduce((n, l) => n + l.subtotalMinor, 0);
  const discountMinor = valid.reduce((n, l) => n + l.discountMinor, 0);
  return {
    currency,
    lines: priced,
    subtotalMinor,
    discountMinor,
    totalMinor: subtotalMinor - discountMinor,
    ok: lines.length > 0 && valid.length === lines.length,
    error: null,
  };
}
