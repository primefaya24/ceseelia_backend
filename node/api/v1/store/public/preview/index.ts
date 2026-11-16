import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { isValidSlug } from "../../../../../constants/slug";
import { WEBAPP_URL } from "../../../../../config";
import { slugForCustomHost, storeUrl } from "../../../../../layers/core/store-url";
import { isUlid } from "../../../../../layers/core/utils";
import { getStorageImageUrl } from "../../../../../layers/core/utils";
import { getSlugOwner } from "../../../../../layers/aws/dynamodb/dynamo-entities/slug";
import { getPublicStoreItem, getStorePreview } from "../../../../../layers/aws/dynamodb/dynamo-entities/store";
import { log } from "../../../../../layers/core/logger";

/*
 * GET /store/public/preview/:slug[/:itemId]  (public; L.9 / WA 3.6 link previews)
 *
 * A tiny HTML page with Open Graph and Twitter tags, for the bots that build link previews
 * (WhatsApp, Facebook, iMessage, Slack...). They don't run JavaScript, so the Angular app can't
 * give them a title or image. The webapp's CloudFront function sends only those bots here, for
 * `/s/<slug>` (and `?item=<id>`); people get the app. A person who lands here anyway is sent on
 * to the store by a link and a refresh.
 *
 * Shows only what the storefront shows: store name, slogan, logo; for a live store's visible
 * item its name, description and first photo. Unknown, suspended or hidden → a plain
 * "Ceseelia" preview with 404, so nothing about them leaks. Cached 5 minutes (CloudFront too).
 */
const SITE = "Ceseelia";
const MAX_DESCRIPTION = 200;

export default function registerRoute(router: Router): void {
  const handle = (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (r) => typeof r.params.slug === "string" && (r.params.itemId === undefined || typeof r.params.itemId === "string"),
      (r) => isValidSlug(String(r.params.slug).toLowerCase()) && (r.params.itemId === undefined || isUlid(r.params.itemId)),
      executeRouteCore,
      false
    );
  };
  router.get("/preview/:slug", handle);
  router.get("/preview/:slug/:itemId", handle);

  // 9.8 phase 2: a store's own domain (the custom-domain distribution's router sends bots here
  // with the host they asked for). Only live domains; anything else gets the plain preview.
  const byHost = (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (r) => typeof r.params.host === "string" && (r.params.itemId === undefined || typeof r.params.itemId === "string"),
      (r) => String(r.params.host).length <= 253 && (r.params.itemId === undefined || isUlid(r.params.itemId)),
      async (r, s) => {
        const slug = slugForCustomHost(String(r.params.host));
        if (!slug) {
          send(s, 404, fallback());
          return;
        }
        await sendPreview(s, slug, r.params.itemId === undefined ? null : String(r.params.itemId));
      },
      false
    );
  };
  router.get("/preview-domain/:host", byHost);
  router.get("/preview-domain/:host/:itemId", byHost);
}

/** Text safe inside an HTML attribute or element (all five specials). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** One line, no control characters, cut at a word to `max` characters. */
export function previewText(s: string, max = MAX_DESCRIPTION): string {
  // eslint-disable-next-line no-control-regex
  const flat = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

const imageUrl = (uri: string): string => (!uri ? "" : /^https:\/\//.test(uri) ? uri : getStorageImageUrl(uri));

export interface PreviewPage {
  title: string;
  description: string;
  image: string;
  url: string;
  type: "website" | "product";
}

export function previewHtml(p: PreviewPage): string {
  const t = escapeHtml(p.title);
  const d = escapeHtml(p.description);
  const u = escapeHtml(p.url);
  const i = escapeHtml(p.image);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${t}</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${u}">
<meta property="og:site_name" content="${SITE}">
<meta property="og:type" content="${p.type}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${u}">
${i ? `<meta property="og:image" content="${i}">\n<meta name="twitter:image" content="${i}">\n` : ""}<meta name="twitter:card" content="${i ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta http-equiv="refresh" content="0; url=${u}">
</head>
<body><p><a href="${u}">${t}</a></p></body>
</html>
`;
}

function send(res: Response, status: number, page: PreviewPage): void {
  res.status(status);
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "public, max-age=300");
  // The page is ours, never framed, runs no script.
  res.set("Content-Security-Policy", "default-src 'none'; img-src https:; frame-ancestors 'none'");
  res.send(previewHtml(page));
}

const fallback = (): PreviewPage => ({
  title: SITE,
  description: "Shop local stores online with Ceseelia.",
  image: "",
  url: WEBAPP_URL,
  type: "website",
});

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  await sendPreview(res, String(req.params.slug).toLowerCase(), req.params.itemId === undefined ? null : String(req.params.itemId));
}

async function sendPreview(res: Response, slug: string, itemId: string | null): Promise<void> {
  // The store's own address (9.8 phase 1), the one shoppers should share.
  const pageUrl = storeUrl(slug);
  try {
    const storeId = await getSlugOwner(slug);
    const store = storeId ? await getStorePreview(storeId) : null;
    if (!storeId || !store || !store.storeName) {
      send(res, 404, fallback());
      return;
    }
    const storePage: PreviewPage = {
      title: store.storeName,
      description: previewText(store.slogan || (store.live ? `Shop ${store.storeName} online.` : `${store.storeName} is coming soon.`)),
      image: imageUrl(store.logoUri),
      url: pageUrl,
      type: "website",
    };
    if (itemId && store.live) {
      const found = await getPublicStoreItem(storeId, itemId).catch(() => null);
      if (found) {
        send(res, 200, {
          title: `${found.item.storeItemName} · ${store.storeName}`,
          description: previewText(found.item.storeItemDescription || storePage.description),
          image: imageUrl(found.item.storeItemImageUris?.[0] ?? "") || storePage.image,
          url: storeUrl(slug, `/?item=${encodeURIComponent(itemId)}`),
          type: "product",
        });
        return;
      }
    }
    // An item that's gone or hidden: the store's own preview (its page is still there).
    send(res, 200, storePage);
  } catch (e) {
    log.error({ err: e }, "In store/public/preview");
    res.set("Cache-Control", "no-store");
    res.status(500).set("Content-Type", "text/html; charset=utf-8").send(previewHtml(fallback()));
  }
}
