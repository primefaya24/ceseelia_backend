/*
 * T.4d: an item's and a store's prices in every offered currency (set by hand, else converted;
 * rules in ./index.ts). Applied where prices are read for shoppers: `toPublicInventory` (the
 * storefront, the item link, Go Live's item count, the quote and create-order, which price from
 * it). The merchant's own reads keep the stored prices; the webapp shows the automatic ones with
 * the same rules.
 */
import { StoreItem, StoreItemPrices, StoreSettings } from "../interfaces/store";
import { variantTotals } from "../variants";
import { effectivePrices, FxRates } from ".";

type Currencies = StoreSettings["currencies"];

/** The item with prices (and its variant rows' prices) for every offered currency. */
export function withEffectiveItemPrices(item: StoreItem, currencies: Currencies, rates: FxRates | null): StoreItem {
  const rows = item.storeItemVariants ?? [];
  if (rows.length === 0) {
    return { ...item, storeItemPrices: effectivePrices(item.storeItemPrices, currencies, rates).prices as StoreItemPrices };
  }
  const filled = rows.map((v) => ({
    ...v,
    storeVariantPrices: effectivePrices(v.storeVariantPrices, currencies, rates).prices as StoreItemPrices,
  }));
  // The item's own prices are its sold rows' lowest, as on save (withVariantTotals).
  return { ...item, storeItemVariants: filled, storeItemPrices: variantTotals(filled).prices };
}

/** Settings with a delivery fee for every offered currency (a fee set by hand wins). */
export function withEffectiveDeliveryFees<S extends Pick<StoreSettings, "currencies"> & { general?: Partial<StoreSettings["general"]> }>(
  settings: S,
  rates: FxRates | null
): S {
  const fees = settings.general?.deliveryFees;
  if (!fees || Object.keys(fees).length === 0) return settings;
  return {
    ...settings,
    general: { ...settings.general, deliveryFees: effectivePrices(fees, settings.currencies, rates).prices as StoreItemPrices },
  };
}
