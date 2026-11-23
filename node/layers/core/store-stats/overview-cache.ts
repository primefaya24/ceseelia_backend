/*
 * Store › Overview answers, kept a short while per store, zone and range (the page polls). A paid
 * order forgets the store's answers at once (`markOrderPaid`), so the "new order" reload the
 * dashboard does on its alert shows the order instead of an answer from before it.
 */
export const OVERVIEW_CACHE_MS = 15_000;
const MAX_ENTRIES = 1000;
const cache = new Map<string, { at: number; body: unknown }>();

const keyOf = (storeId: string, tz: string, days: number | null) => `${storeId}|${tz}|${days ?? ""}`;

export function getCachedOverview<T>(storeId: string, tz: string, days: number | null, now = Date.now()): T | null {
  const hit = cache.get(keyOf(storeId, tz, days));
  return hit && now - hit.at < OVERVIEW_CACHE_MS ? (hit.body as T) : null;
}

export function setCachedOverview(storeId: string, tz: string, days: number | null, body: unknown, now = Date.now()): void {
  if (cache.size > MAX_ENTRIES) cache.clear();
  cache.set(keyOf(storeId, tz, days), { at: now, body });
}

/** Drop every cached answer for a store (a new paid order). */
export function forgetStoreOverview(storeId: string): void {
  const prefix = `${storeId}|`;
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

export function resetOverviewCache(): void {
  cache.clear();
}
