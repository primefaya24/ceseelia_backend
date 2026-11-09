// Store slug rules (progress.md 1.8). The webapp mirrors these in
// `src/app/core/constants/slug.constants.ts`; keep the two in sync.

import { MAX_LENGTH } from "./input-limits";

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = MAX_LENGTH.storeSlug; // 40

/* Lowercase letters and digits, in groups joined by single hyphens (no leading/trailing hyphen). */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/* Words a store can't take: app routes, infrastructure names, and things that would confuse buyers. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "about", "account", "admin", "administrator", "api", "app", "assets", "auth", "billing", "blog",
  "cart", "cdn", "ceseelia", "checkout", "contact", "customer", "customers", "dashboard", "dev",
  "docs", "edit", "eula", "faq", "help", "home", "legal", "login", "logout", "mail", "merchant",
  "merchants", "new", "null", "official", "order", "orders", "privacy", "profile", "root",
  "settings", "signin", "signup", "sign-in", "sign-up", "staff", "staging", "static", "status",
  "store", "stores", "storefront", "support", "system", "terms", "undefined", "www",
]);

export function isValidSlug(slug: unknown): slug is string {
  return (
    typeof slug === "string" &&
    slug.length >= SLUG_MIN_LENGTH &&
    slug.length <= SLUG_MAX_LENGTH &&
    SLUG_PATTERN.test(slug) &&
    !RESERVED_SLUGS.has(slug)
  );
}
