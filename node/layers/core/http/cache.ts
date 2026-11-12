import { Response } from "express";

/*
 * Cache-Control for the public endpoints (progress.md 3.2). Express already adds a weak ETag to
 * every response and answers a matching If-None-Match with 304, so a revalidation is cheap.
 *   - storefront / item: `private`. The body depends on the shopper (their geo-IP currency is
 *     the default), so a shared cache (CloudFront) must not keep one copy for everyone.
 *     `no-cache` (QA Q.21): the browser keeps the copy but asks every time (a 304 via the ETag
 *     when nothing changed), so an item the merchant disables or discounts shows at once when an
 *     open storefront refreshes. (It was `max-age=30`, which served the old copy for 30 s.)
 *   - slug → storeId: the same for everyone and rarely changes, so `public` for 5 minutes.
 *   - errors and writes: `no-store`, so a store that's fixed or goes live shows up at once.
 */
export const CACHE_CONTROL = {
  storefront: "private, no-cache",
  slug: "public, max-age=300",
  none: "no-store",
} as const;

/* For uploaded images: every upload gets a new key, so a stored object never changes. */
export const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function setCacheControl(res: Response, value: (typeof CACHE_CONTROL)[keyof typeof CACHE_CONTROL]): void {
  res.set("Cache-Control", value);
}
