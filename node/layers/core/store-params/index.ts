import { NUMBER_RANGE, STOCK_UNLIMITED } from "../../../constants/input-limits";
import type {
  StoreItem,
  StoreItemPrices,
  StoreItemVariant,
  StoreParamDef,
  StoreParameter,
} from "../interfaces/store";
import { isVariantParam, paramOptionList, variantCombinations, variantParams, withVariantTotals } from "../variants";

/*
 * Store parameters (progress.md Stage R).
 *
 *   - A store defines a parameter once (`StoreParamDef`: Shape, Size #Rings…) and picks it on
 *     items. Each item keeps a *copy* (`StoreParameter` with `storeParamId`), written from the
 *     store parameter by the server on every item save (`syncItemParams`) and on every parameter
 *     save (`applyParamDef`) or delete (`removeParamFromItem`). Storefront, pricing, orders and the
 *     AI check read the copy, so they work exactly as before.
 *   - The key is `name#tag` (just `name` without a tag), unique per store ignoring case. Shoppers
 *     only ever see the name.
 *   - A parameter edit reshapes each item's variant rows (R.0c), keeping what the merchant set:
 *       · renamed option (`renames` {old: new}) → its rows keep their stock, price and "sold";
 *       · new option → rows copied from the first option's (price, sold), stock unlimited if
 *         that row's is, else 0 (never invents stock);
 *       · removed option → its rows go;
 *       · variants switched on → the item's price on every row; the first option takes the
 *         item's stock, the others get unlimited if the item's is, else 0 (same total);
 *       · variants switched off, or the parameter removed → rows that only differed by it merge:
 *         stock = the sold rows' sum (unlimited if any is), price = the first sold row's.
 *   - Per-item exceptions (hiding some options on one item) are not in v1 (R.0e). They would be
 *     an extra field on the item's copy, applied in `itemParamFromDef`'s caller.
 *
 * The webapp mirrors `paramKey` and `itemParamFromDef` in `core/functions/store-param.functions.ts`.
 */

const clean = (s: unknown): string => (typeof s === "string" ? s.trim() : "");

/** "Size#Rings", or "Size" without a tag. */
export const paramKey = (d: Pick<StoreParamDef, "storeParamName" | "storeParamTag">): string =>
  clean(d.storeParamTag) ? `${clean(d.storeParamName)}#${clean(d.storeParamTag)}` : clean(d.storeParamName);

/** Whether two parameters have the same key (ignoring case). */
export const sameParamKey = (
  a: Pick<StoreParamDef, "storeParamName" | "storeParamTag">,
  b: Pick<StoreParamDef, "storeParamName" | "storeParamTag">
): boolean => paramKey(a).toLowerCase() === paramKey(b).toLowerCase();

/** The parameter as it is saved: trimmed, blank options dropped, no variants on multiple choice. */
export function cleanParamDef(d: StoreParamDef): StoreParamDef {
  return {
    storeParamId: clean(d.storeParamId),
    storeParamName: clean(d.storeParamName),
    storeParamTag: clean(d.storeParamTag),
    storeParamType: d.storeParamType,
    storeParamIsMandatory: d.storeParamIsMandatory,
    storeParamOptions: (d.storeParamOptions ?? []).map(clean).filter((o) => o.length > 0),
    storeParamHasVariants: d.storeParamType === "SINGLE_SELECT" && d.storeParamHasVariants === true,
  };
}

/** The copy an item keeps of a store parameter. Variant params are always required (2.7). */
export function itemParamFromDef(d: StoreParamDef): StoreParameter {
  const hasVariants = d.storeParamType === "SINGLE_SELECT" && d.storeParamHasVariants === true;
  return {
    storeParamId: d.storeParamId,
    storeParamLabel: clean(d.storeParamName),
    storeParamType: d.storeParamType,
    storeParamIsMandatory: hasVariants ? true : d.storeParamIsMandatory,
    storeParamOptions: (d.storeParamOptions ?? []).map(clean).filter((o) => o.length > 0),
    storeParamHasVariants: hasVariants,
  };
}

/** Thrown by `syncItemParams` for a parameter id the store doesn't have. */
export class UnknownStoreParamError extends Error {
  constructor(public readonly paramId: string) {
    super("Unknown parameter");
    this.name = "UnknownStoreParamError";
  }
}

/**
 * An item being saved (R.4): each linked param is rewritten from the store's parameter (the
 * client only chooses which ones and in what order). Item-only params (no id, from before
 * Stage R) are left as sent. The rows are left as sent: they're matched by label, then checked.
 */
export function syncItemParams(item: StoreItem, defs: StoreParamDef[]): StoreItem {
  const byId = new Map(defs.map((d) => [d.storeParamId, d]));
  const params = (item.storeItemCustomParams ?? []).map((p) => {
    if (p.storeParamId === undefined) return p;
    const d = byId.get(p.storeParamId);
    if (!d) throw new UnknownStoreParamError(p.storeParamId);
    return itemParamFromDef(d);
  });
  return { ...item, storeItemCustomParams: params };
}

/** Whether an item uses this store parameter. */
export const itemUsesParam = (item: Pick<StoreItem, "storeItemCustomParams">, paramId: string): boolean =>
  (item.storeItemCustomParams ?? []).some((p) => p.storeParamId === paramId);

/** The item after a parameter save (R.3b). Unchanged if it doesn't use the parameter. */
export function applyParamDef(item: StoreItem, def: StoreParamDef, renames: Record<string, string> = {}): StoreItem {
  return replaceItemParam(item, def.storeParamId, itemParamFromDef(def), renames);
}

/** The item after a parameter delete (R.3c). Unchanged if it doesn't use the parameter. */
export function removeParamFromItem(item: StoreItem, paramId: string): StoreItem {
  return replaceItemParam(item, paramId, null, {});
}

/** Whether a save would change what's stored for the item. */
export function itemParamsChanged(before: StoreItem, after: StoreItem): boolean {
  const pick = (i: StoreItem) =>
    JSON.stringify([i.storeItemCustomParams ?? [], i.storeItemVariants ?? [], i.storeItemStock, i.storeItemPrices ?? {}]);
  return pick(before) !== pick(after);
}

/* A row's sellable state, where a new row's values come from. */
interface RowSource {
  prices: StoreItemPrices;
  stock: number;
  active: boolean;
}

function replaceItemParam(
  item: StoreItem,
  paramId: string,
  next: StoreParameter | null,
  renames: Record<string, string>
): StoreItem {
  const params = item.storeItemCustomParams ?? [];
  const idx = params.findIndex((p) => p.storeParamId === paramId);
  if (idx < 0) return item;
  const old = params[idx];
  const newParams = next ? params.map((p, i) => (i === idx ? next : p)) : params.filter((_, i) => i !== idx);
  const storeItemVariants = rebuildRows(item, old, next, newParams, renames);
  return withVariantTotals({ ...item, storeItemCustomParams: newParams, storeItemVariants });
}

const sumStock = (a: number, b: number): number =>
  a === STOCK_UNLIMITED || b === STOCK_UNLIMITED ? STOCK_UNLIMITED : Math.min(a + Math.max(0, b), NUMBER_RANGE.stock.max);

function rebuildRows(
  item: StoreItem,
  old: StoreParameter,
  next: StoreParameter | null,
  newParams: StoreParameter[],
  renames: Record<string, string>
): StoreItemVariant[] {
  const label = (p: StoreParameter) => clean(p.storeParamLabel);
  const oldVP = variantParams(item.storeItemCustomParams);
  const newVP = variantParams(newParams);
  const rows = item.storeItemVariants ?? [];
  // No variants left: the item keeps the stock and prices it had (for a variant item those are
  // already the rows' totals, worked out on its last save).
  if (newVP.length === 0) return [];
  const combos = variantCombinations(newParams);
  // Over the cap: leave the rows; the caller's validation refuses the item.
  if (combos.length === 0) return rows;

  const oldIsV = isVariantParam(old);
  const newIsV = next !== null && isVariantParam(next);
  const oldOpts = paramOptionList(old);
  // New option → the old option it was (a rename, or the same text).
  const newToOld = new Map<string, string>();
  for (const o of oldOpts) {
    const n = clean(renames[o] ?? o);
    if (!newToOld.has(n)) newToOld.set(n, o);
  }
  const base: RowSource = {
    prices: { ...(item.storeItemPrices ?? {}) },
    stock: item.storeItemStock,
    active: true,
  };

  return combos.map((combo) => {
    let fresh = false;
    let source: RowSource | null;
    if (oldVP.length === 0) {
      source = base;
    } else {
      // Which old rows this combination comes from: null = any value (rows that merge).
      const pattern: Record<string, string | null> = {};
      for (const p of oldVP) {
        if (p === old) {
          if (newIsV) {
            const was = newToOld.get(combo[label(next!)]);
            fresh = was === undefined;
            pattern[label(p)] = was ?? oldOpts[0];
          } else {
            pattern[label(p)] = null;
          }
        } else {
          pattern[label(p)] = combo[label(p)];
        }
      }
      const matching = rows.filter((r) =>
        Object.entries(pattern).every(([k, v]) => v === null || clean(r.storeVariantOptions?.[k]) === v)
      );
      if (matching.length === 0) {
        source = null;
      } else if (matching.length === 1) {
        const r = matching[0];
        source = { prices: { ...r.storeVariantPrices }, stock: r.storeVariantStock, active: r.storeVariantIsActive };
      } else {
        const sold = matching.filter((r) => r.storeVariantIsActive);
        const first = sold[0] ?? matching[0];
        source = {
          prices: { ...first.storeVariantPrices },
          stock: sold.reduce((n, r) => sumStock(n, r.storeVariantStock), 0),
          active: sold.length > 0,
        };
      }
    }
    // Variants just switched on for this param: the first option carries the stock.
    if (newIsV && !oldIsV) fresh = combo[label(next!)] !== paramOptionList(next!)[0];

    if (!source) {
      // A combination the item never had a row for (an item saved before 2.7 without its table).
      const prices = { ...(item.storeItemPrices ?? {}) };
      return { storeVariantOptions: combo, storeVariantStock: 0, storeVariantPrices: prices, storeVariantIsActive: Object.keys(prices).length > 0 };
    }
    return {
      storeVariantOptions: combo,
      storeVariantPrices: source.prices,
      storeVariantIsActive: source.active,
      storeVariantStock: fresh ? (source.stock === STOCK_UNLIMITED ? STOCK_UNLIMITED : 0) : source.stock,
    };
  });
}
