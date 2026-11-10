/*
 * Canadian sales tax (progress.md 4.4). Pure: no I/O. The rates live only here, on the server;
 * the webapp never sends a rate or a tax amount, it only shows what the quote returns.
 *
 * Rules (general rules, not tax advice; have an accountant confirm before launch):
 *   - The province is where the goods end up: the shopper's for delivery (from the postal
 *     code), the store's own for pickup.
 *   - GST/HST is charged only when the merchant is registered for it. A small supplier (under
 *     about $30k a year) needn't register, and then charges none.
 *   - HST provinces (ON, NB, NL, NS, PE) have one combined tax and no separate provincial one.
 *   - BC, SK and MB (PST/RST) and QC (QST) add a provincial tax on top of the 5% GST, but only
 *     when the merchant is registered in that province.
 *   - The taxable amount is the goods after discount plus the delivery fee, for every part.
 *     (Simplification: some provinces treat delivery charges differently.)
 *   - Each part is rounded half up to a cent on its own.
 *
 * Update CA_TAX_RATES and CA_TAX_RATES_AS_OF together when a rate changes.
 */

export const CA_PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"] as const;
export type CaProvince = (typeof CA_PROVINCES)[number];

export const CA_PROVINCE_NAMES: Record<CaProvince, string> = {
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  NT: "Northwest Territories",
  NU: "Nunavut",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
  YT: "Yukon",
};

/** Provinces with their own sales tax on top of GST; a merchant registers in each separately. */
export const CA_PROVINCIAL_TAX_PROVINCES = ["BC", "MB", "QC", "SK"] as const satisfies readonly CaProvince[];
export type CaProvincialTaxProvince = (typeof CA_PROVINCIAL_TAX_PROVINCES)[number];

export const CA_TAX_RATES_AS_OF = "2025-04-01";

export type CaTaxCode = "GST" | "HST" | "PST" | "RST" | "QST";

interface ProvinceRates {
  /** HST replaces GST in these provinces. */
  hst?: number;
  provincial?: { code: "PST" | "RST" | "QST"; percent: number };
}

const GST_PERCENT = 5;

export const CA_TAX_RATES: Record<CaProvince, ProvinceRates> = {
  AB: {},
  BC: { provincial: { code: "PST", percent: 7 } },
  MB: { provincial: { code: "RST", percent: 7 } },
  NB: { hst: 15 },
  NL: { hst: 15 },
  NS: { hst: 14 },
  NT: {},
  NU: {},
  ON: { hst: 13 },
  PE: { hst: 15 },
  QC: { provincial: { code: "QST", percent: 9.975 } },
  SK: { provincial: { code: "PST", percent: 6 } },
  YT: {},
};

/** What a store in Canada mode saves (`StoreSettings.general.canadaTax`). */
export interface CanadaTaxSettings {
  /** Where the store is; pickup orders are taxed here. */
  homeProvince: CaProvince;
  /** Registered for GST/HST. Off = small supplier: no GST/HST is charged. */
  gstRegistered: boolean;
  /** Provinces the store is registered in for PST/RST/QST. */
  provincialRegistrations: CaProvincialTaxProvince[];
}

export interface CaTaxComponent {
  code: CaTaxCode;
  /** e.g. "HST", shown on the cart line. */
  label: string;
  percent: number;
}

export function isCaProvince(v: unknown): v is CaProvince {
  return typeof v === "string" && (CA_PROVINCES as readonly string[]).includes(v);
}

export function isCaProvincialTaxProvince(v: unknown): v is CaProvincialTaxProvince {
  return typeof v === "string" && (CA_PROVINCIAL_TAX_PROVINCES as readonly string[]).includes(v);
}

export function isCanadaTaxSettings(v: unknown): v is CanadaTaxSettings {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  const regs = s.provincialRegistrations;
  return (
    isCaProvince(s.homeProvince) &&
    typeof s.gstRegistered === "boolean" &&
    Array.isArray(regs) &&
    regs.length <= CA_PROVINCIAL_TAX_PROVINCES.length &&
    regs.every(isCaProvincialTaxProvince) &&
    new Set(regs).size === regs.length
  );
}

/** The tax parts charged on goods ending up in `province`, for this store. */
export function canadaTaxComponents(province: CaProvince, settings: CanadaTaxSettings): CaTaxComponent[] {
  const rates = CA_TAX_RATES[province];
  const parts: CaTaxComponent[] = [];
  if (settings.gstRegistered) {
    parts.push(rates.hst ? { code: "HST", label: "HST", percent: rates.hst } : { code: "GST", label: "GST", percent: GST_PERCENT });
  }
  const provincial = rates.provincial;
  if (provincial && (settings.provincialRegistrations as string[]).includes(province)) {
    parts.push({ code: provincial.code, label: provincial.code, percent: provincial.percent });
  }
  return parts;
}

/** True when this store could charge any tax at all (so a delivery needs the shopper's province). */
export function chargesAnyCanadaTax(settings: CanadaTaxSettings): boolean {
  return settings.gstRegistered || settings.provincialRegistrations.length > 0;
}

/* First letter of a postal code → province (Canada Post). X covers both NT and NU (same rates). */
const POSTAL_PREFIX: Record<string, CaProvince> = {
  A: "NL",
  B: "NS",
  C: "PE",
  E: "NB",
  G: "QC",
  H: "QC",
  J: "QC",
  K: "ON",
  L: "ON",
  M: "ON",
  N: "ON",
  P: "ON",
  R: "MB",
  S: "SK",
  T: "AB",
  V: "BC",
  X: "NT",
  Y: "YT",
};

/** Canada Post format: A1A 1A1 (no D, F, I, O, Q, U; no W or Z first). */
const POSTAL_CODE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/;

/** "k1a0b1" / "K1A 0B1" → "K1A 0B1"; null if it isn't a valid Canadian postal code. */
export function normalizePostalCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 10) return null;
  const compact = raw.replace(/[\s-]/g, "").toUpperCase();
  return POSTAL_CODE.test(compact) ? `${compact.slice(0, 3)} ${compact.slice(3)}` : null;
}

export function provinceFromPostalCode(raw: unknown): CaProvince | null {
  const code = normalizePostalCode(raw);
  return code ? POSTAL_PREFIX[code[0]] ?? null : null;
}
