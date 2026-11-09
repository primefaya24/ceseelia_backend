// Small value checks shared by the request validators (progress.md S.9). Format rules match the
// webapp's `src/app/core/functions/input-validation.functions.ts`. Empty strings are allowed
// where a field is optional; the caller decides.

export const isMaxLength = (v: string, max: number): boolean => v.length <= max;

export const isInRange = (v: number, range: { min: number; max: number }): boolean =>
  Number.isFinite(v) && v >= range.min && v <= range.max;

/* At most 2 decimal places (prices are entered in cents precision). */

/* Empty, or an http(s) URL whose host has a dot. */
export function isUrlOrEmpty(v: string): boolean {
  const s = v.trim();
  if (!s) return true;
  try {
    const url = new URL(s);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.includes(".");
  } catch {
    return false;
  }
}

export function isEmailOrEmpty(v: string): boolean {
  const s = v.trim();
  return !s || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/* Empty, or digits with optional +, spaces, dashes and brackets; 7-15 digits. */
export function isPhoneOrEmpty(v: string): boolean {
  const s = v.trim();
  if (!s) return true;
  const digits = s.replace(/\D/g, "").length;
  return /^\+?[\d\s()-]+$/.test(s) && digits >= 7 && digits <= 15;
}

export const isHexColor = (v: string): boolean => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v);

const IMAGE_FILE = "[0-7][0-9A-HJKMNP-TV-Z]{25}\\.(?:png|jpe?g)";

/*
 * Empty, or an S3 key the upload routes generate for this store: `<folder><ULID>.<png|jpg|jpeg>`.
 * `folder` must end with "/" and is built from IDs that were already checked with isUlid.
 */
export function isImageKeyOrEmpty(v: string, folder: string): boolean {
  if (v === "") return true;
  return v.startsWith(folder) && new RegExp(`^${IMAGE_FILE}$`).test(v.slice(folder.length));
}

export const storeImageFolder = {
  logo: (storeId: string) => `store/${storeId}/images/logo/`,
  header: (storeId: string) => `store/${storeId}/images/header/`,
  promo: (storeId: string) => `store/${storeId}/images/promo/`,
  categoryBanner: (storeId: string, categoryId: string) => `store/${storeId}/category/${categoryId}/images/`,
  item: (storeId: string, itemId: string) => `store/${storeId}/item/${itemId}/images/`,
};

/* For user text placed in an HTML email. */
export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
