import { StoreItem } from "../interfaces/store";
import { RuleHit } from "./rules";

/*
 * Which items the AI sees a photo of (L.2, owner 2026-11-14). Every item's TEXT is always
 * checked; images cost far more, so at most MAX_IMAGES item images go in, picked by risk:
 *   1. items the rule checks hinted at,
 *   2. the highest-priced items (counterfeits and too-good-to-be-true listings cluster there),
 *   3. random picks for the rest, so nobody can predict which photos are looked at.
 * A purely random 50 of 500 items would usually miss a handful of bad listings.
 */
export const MAX_IMAGES = 50;
/* Items per AI request; bigger catalogues are split and checked in parallel. */
export const ITEMS_PER_REQUEST = 150;

type Rng = () => number;

const topPrice = (i: Pick<StoreItem, "storeItemPrices">) => Math.max(0, ...Object.values(i.storeItemPrices ?? {}));

export function pickImageItems(
  items: Pick<StoreItem, "storeItemId" | "storeItemImageUris" | "storeItemPrices">[],
  hints: RuleHit[],
  max = MAX_IMAGES,
  rng: Rng = Math.random
): Set<string> {
  const withImage = items.filter((i) => (i.storeItemImageUris ?? []).length > 0);
  const picked = new Set<string>();
  const add = (id: string) => {
    if (picked.size < max) picked.add(id);
  };

  const hinted = new Set(hints.map((h) => h.itemId).filter((id): id is string => !!id));
  for (const i of withImage) if (hinted.has(i.storeItemId)) add(i.storeItemId);

  // Up to half of what's left goes to the priciest items.
  const priceShare = Math.floor((max - picked.size) / 2);
  const byPrice = withImage.filter((i) => !picked.has(i.storeItemId)).sort((a, b) => topPrice(b) - topPrice(a));
  for (const i of byPrice.slice(0, priceShare)) add(i.storeItemId);

  // The rest at random (Fisher-Yates on what's left).
  const rest = withImage.filter((i) => !picked.has(i.storeItemId));
  for (let k = rest.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    [rest[k], rest[j]] = [rest[j], rest[k]];
  }
  for (const i of rest) add(i.storeItemId);
  return picked;
}

export function chunk<T>(list: T[], size = ITEMS_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let k = 0; k < list.length; k += size) out.push(list.slice(k, k + size));
  return out.length ? out : [[]];
}
