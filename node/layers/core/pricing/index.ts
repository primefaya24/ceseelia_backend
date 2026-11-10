import { MAX_QUANTITY_PER_LINE } from "../../../constants/input-limits";
import {
  fulfilmentSettings,
  isUnlimitedStock,
  StoreCategory,
  StoreItem,
  StoreParameter,
  StoreSettings,
} from "../interfaces/store";
import {
  CA_PROVINCE_NAMES,
  canadaTaxComponents,
  CaProvince,
  CaTaxCode,
  chargesAnyCanadaTax,
  provinceFromPostalCode,
} from "../tax/canada";

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
 *   - Fulfilment (4.2): PICKUP or DELIVERY, whichever the store offers (pickup first by
 *     default). Delivery is a flat fee per currency, charged only when some line can be bought.
 *   - Tax (4.2): `taxPercent` of the goods after discount plus delivery, rounded half up once on
 *     the whole cart. With `pricesIncludeTax` it is the part of that amount that is tax
 *     (amount × r / (100 + r)) and adds nothing; otherwise it is added to the total.
 *   - Canadian tax (4.4, `taxMode: "CANADA"`): the parts (GST/HST, PST/RST/QST) for the province
 *     the goods end up in: the store's home province for pickup, the one from the shopper's
 *     postal code for delivery (`opts.postalCode`). Each part is its own percent of the same
 *     taxable amount, rounded on its own, and added to the total. A delivery with no valid
 *     postal code gets no tax and `error: POSTAL_CODE_REQUIRED` / `INVALID_POSTAL_CODE`.
 *     The rates and rules are in `layers/core/tax/canada.ts`; nothing about tax comes from the
 *     client except the postal code.
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

export type Fulfilment = "PICKUP" | "DELIVERY";

/** One tax part on the quote, e.g. HST 13%. FLAT stores have one "TAX" part. */
export interface TaxLine {
  code: CaTaxCode | "TAX";
  label: string;
  percent: number;
  minor: number;
}

export type QuoteErrorCode =
  | "CURRENCY_NOT_OFFERED"
  | "FULFILMENT_UNAVAILABLE"
  | "POSTAL_CODE_REQUIRED"
  | "INVALID_POSTAL_CODE";

export interface Quote {
  currency: string;
  lines: PricedLine[];
  subtotalMinor: number;
  discountMinor: number;
  /** What the shopper can choose, with the fee in this currency. */
  fulfilmentOptions: { method: Fulfilment; feeMinor: number }[];
  /** The one priced (the shopper's choice, else the first option); null if none is available. */
  fulfilment: Fulfilment | null;
  deliveryMinor: number;
  /** The sum of the tax parts' percents. */
  taxPercent: number;
  pricesIncludeTax: boolean;
  /** The tax parts (4.4); empty when no tax is charged. Their `minor`s add up to `taxMinor`. */
  taxLines: TaxLine[];
  /** Canada mode: the province taxed (null in FLAT mode, or when it isn't known yet). */
  taxRegion: { province: CaProvince; name: string } | null;
  taxMinor: number;
  /** Goods after discount + delivery, + tax unless prices include it. */
  totalMinor: number;
  ok: boolean;
  /**
   * Whole-quote problem. CURRENCY_NOT_OFFERED: nothing is priced (lines empty).
   * FULFILMENT_UNAVAILABLE: the lines are priced, but the chosen method isn't offered.
   * POSTAL_CODE_REQUIRED / INVALID_POSTAL_CODE (4.4): a Canada-mode delivery needs a valid
   * Canadian postal code to know the tax; everything else is priced, tax is 0 until then.
   */
  error: { code: QuoteErrorCode; message: string } | null;
}

export interface PricingStore {
  settings: { currencies: StoreSettings["currencies"]; general?: Partial<StoreSettings["general"]> };
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

/** The tax inside an amount that already includes it: amount × r / (100 + r), half up. */
export function includedTaxOf(amountMinor: number, percent: number): number {
  const bp = Math.round(percent * 100);
  if (bp <= 0) return 0;
  const denominator = 10000 + bp;
  return Math.floor((2 * amountMinor * bp + denominator) / (2 * denominator));
}

/** `amount × percent / 100`, rounded half up to a whole cent. */
export function percentOf(amountMinor: number, percent: number): number {
  // Thousandths of a percent as integers (Quebec's QST is 9.975%), in BigInt so a large cart
  // can't lose precision, and so 12.5% of 2 cents isn't lost to float error either.
  const milli = BigInt(Math.round(percent * 1000));
  if (milli <= BigInt(0)) return 0;
  return Number((BigInt(amountMinor) * milli + BigInt(50_000)) / BigInt(100_000));
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

export function priceLines(
  store: PricingStore,
  lines: QuoteLineInput[],
  currency: string,
  opts: { fulfilment?: Fulfilment; postalCode?: string } = {}
): Quote {
  const f = fulfilmentSettings(store.settings.general);
  if (!store.settings.currencies.some((c) => c.currencyCode === currency)) {
    return {
      currency,
      lines: [],
      subtotalMinor: 0,
      discountMinor: 0,
      fulfilmentOptions: [],
      fulfilment: null,
      deliveryMinor: 0,
      taxPercent: f.taxMode === "CANADA" ? 0 : f.taxPercent,
      pricesIncludeTax: f.taxMode === "CANADA" ? false : f.pricesIncludeTax,
      taxLines: [],
      taxRegion: null,
      taxMinor: 0,
      totalMinor: 0,
      ok: false,
      error: { code: "CURRENCY_NOT_OFFERED", message: `This store doesn't sell in ${currency}.` },
    };
  }
  const deliveryFee = f.deliveryFees[currency as keyof typeof f.deliveryFees];
  const fulfilmentOptions: Quote["fulfilmentOptions"] = [];
  if (f.pickupEnabled) fulfilmentOptions.push({ method: "PICKUP", feeMinor: 0 });
  if (f.deliveryEnabled && Number.isInteger(deliveryFee)) {
    fulfilmentOptions.push({ method: "DELIVERY", feeMinor: deliveryFee as number });
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

  const wanted = opts.fulfilment ?? fulfilmentOptions[0]?.method;
  const chosen = fulfilmentOptions.find((o) => o.method === wanted) ?? null;
  const deliveryMinor = chosen && valid.length > 0 ? chosen.feeMinor : 0;
  const taxable = subtotalMinor - discountMinor + deliveryMinor;
  const tax = taxFor(f, chosen?.method ?? null, taxable, opts.postalCode);
  const error: Quote["error"] = chosen
    ? tax.error
    : {
        code: "FULFILMENT_UNAVAILABLE",
        message: wanted === "DELIVERY" ? `This store doesn't deliver in ${currency}.` : "This store doesn't offer pickup.",
      };
  return {
    currency,
    lines: priced,
    subtotalMinor,
    discountMinor,
    fulfilmentOptions,
    fulfilment: chosen?.method ?? null,
    deliveryMinor,
    taxPercent: tax.percent,
    pricesIncludeTax: tax.included,
    taxLines: tax.lines,
    taxRegion: tax.region,
    taxMinor: tax.minor,
    totalMinor: taxable + (tax.included ? 0 : tax.minor),
    ok: lines.length > 0 && valid.length === lines.length && !!chosen && !error,
    error,
  };
}

/** The tax on `taxable` for this store and fulfilment (4.2 flat rate, or 4.4 Canada). */
function taxFor(
  f: ReturnType<typeof fulfilmentSettings>,
  method: Fulfilment | null,
  taxable: number,
  postalCode: string | undefined
): {
  lines: TaxLine[];
  minor: number;
  percent: number;
  included: boolean;
  region: Quote["taxRegion"];
  error: Quote["error"];
} {
  const none = { lines: [], minor: 0, percent: 0, included: false, region: null, error: null };
  if (f.taxMode !== "CANADA") {
    const minor = f.pricesIncludeTax ? includedTaxOf(taxable, f.taxPercent) : percentOf(taxable, f.taxPercent);
    const lines: TaxLine[] = f.taxPercent > 0 ? [{ code: "TAX", label: "Tax", percent: f.taxPercent, minor }] : [];
    return { ...none, lines, minor, percent: f.taxPercent, included: f.pricesIncludeTax };
  }
  const settings = f.canadaTax;
  // Saved settings are validated, but don't trust a half-written record: no settings, no tax.
  if (!settings || !method || !chargesAnyCanadaTax(settings)) return none;
  let province: CaProvince | null = settings.homeProvince;
  if (method === "DELIVERY") {
    if (!postalCode) {
      return { ...none, error: { code: "POSTAL_CODE_REQUIRED", message: "Enter your postal code to see the tax." } };
    }
    province = provinceFromPostalCode(postalCode);
    if (!province) {
      return {
        ...none,
        error: { code: "INVALID_POSTAL_CODE", message: "Enter a Canadian postal code, like K1A 0B1." },
      };
    }
  }
  const lines: TaxLine[] = canadaTaxComponents(province, settings).map((c) => ({
    ...c,
    minor: percentOf(taxable, c.percent),
  }));
  return {
    lines,
    minor: lines.reduce((n, l) => n + l.minor, 0),
    // Round away float noise (5 + 9.975)
    percent: Math.round(lines.reduce((n, l) => n + l.percent, 0) * 1000) / 1000,
    included: false,
    region: { province, name: CA_PROVINCE_NAMES[province] },
    error: null,
  };
}
