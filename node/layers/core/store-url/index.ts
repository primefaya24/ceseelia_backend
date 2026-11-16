import { STORE_URL_TEMPLATE, WEBAPP_URL } from "../../../config";
import { SLUG_PATTERN } from "../../../constants/slug";

/*
 * A store's public address (9.8 phase 1). With STORE_URL_TEMPLATE (prod:
 * `https://{slug}.ceseelia.com`) every store has its own subdomain and its pages sit at the root
 * (`/`, `/checkout`, `/order/<id>`); without it (dev default) they're under the app at
 * `/s/<slug>`. The webapp mirrors this in `core/functions/store-url.functions.ts`.
 */

const SLUG_IN_HOST = SLUG_PATTERN.source.replace(/^\^/, "").replace(/\$$/, "");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The template as a pattern matching a store origin; null when there's no template. */
export function storeOriginPattern(template: string = STORE_URL_TEMPLATE): RegExp | null {
  if (!template || !template.includes("{slug}")) return null;
  const [before, after] = template.split("{slug}");
  return new RegExp(`^${escapeRegExp(before)}(${SLUG_IN_HOST})${escapeRegExp(after)}$`);
}

/** The slug of a store origin (`https://northern-hoop.ceseelia.com` → `northern-hoop`), or null. */
export function slugFromStoreOrigin(origin: string, template: string = STORE_URL_TEMPLATE): string | null {
  const m = storeOriginPattern(template)?.exec(origin.toLowerCase());
  return m ? m[1] : null;
}

/**
 * A store page's full URL: `storeUrl("northern-hoop", "/order/X")` →
 * `https://northern-hoop.ceseelia.com/order/X`, or `${WEBAPP_URL}/s/northern-hoop/order/X`.
 * `path` starts with "/" (or is empty for the storefront).
 */
export function storeUrl(
  slug: string,
  path = "",
  opts: { template?: string; webappUrl?: string } = {}
): string {
  const template = opts.template ?? STORE_URL_TEMPLATE;
  const webappUrl = (opts.webappUrl ?? WEBAPP_URL).replace(/\/+$/, "");
  const s = encodeURIComponent(slug);
  if (template && template.includes("{slug}")) {
    return `${template.replace("{slug}", s)}${path || "/"}`;
  }
  // `/?item=X` on a subdomain is `?item=X` after `/s/<slug>`.
  return `${webappUrl}/s/${s}${path.startsWith("/?") ? path.slice(1) : path}`;
}
