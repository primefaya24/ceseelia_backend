// Server-side input limits (progress.md S.9). Lengths and ranges match the webapp's
// `src/app/core/constants/input-limits.constants.ts` (WA S.15); keep the two in sync.

/* Max string lengths, in characters. */
export const MAX_LENGTH = {
  storeName: 60,
  // A Canadian postal code with a space or dash ("K1A 0B1"); a little slack for stray spaces (4.4)
  postalCode: 10,
  personName: 50,
  storeSlug: 40,
  storeSlogan: 120,
  categoryName: 60,
  itemName: 80,
  itemDescription: 500,
  hashtag: 30,
  hashtagId: 40,
  paramLabel: 40,
  paramOption: 40,
  rewardsLabel: 30,
  pickupAddress: 200,
  promoRunnerText: 150,
  email: 254,
  phone: 20,
  url: 300,
  imageUri: 200,
  templateId: 40,
  currencySign: 5,
  contactMessage: 2000,
} as const;

/*
 * Stock rule (progress.md 2.6): `storeItemStock` is either STOCK_UNLIMITED (never runs out, never
 * goes down) or a tracked count >= 0 (0 = sold out). Paid orders lower tracked stock (5.5).
 */
export const STOCK_UNLIMITED = -1;

/* The most of one cart line (4.1); the webapp's item sheet and cart use the same 99. */
export const MAX_QUANTITY_PER_LINE = 99;

/* Numeric ranges (inclusive). */
export const NUMBER_RANGE = {
  percent: { min: 0, max: 100 },
  // Sales tax / GST / VAT rate a store charges (4.2)
  taxPercent: { min: 0, max: 30 },
  price: { min: 0, max: 1_000_000 },
  // Item prices in minor units (cents), per currency (progress.md 2.5): up to 1,000,000.00
  priceMinor: { min: 0, max: 100_000_000 },
  // STOCK_UNLIMITED (-1) or a tracked count 0..1,000,000 (progress.md 2.6)
  stock: { min: -1, max: 1_000_000 },
  points: { min: 0, max: 1_000_000 },
  // Platform commission per order, minor units per currency (5.1a): up to 1,000.00
  salesCommissionMinor: { min: 0, max: 100_000 },
  // Percentage commission in basis points (5.1b): 0–30%
  commissionPercentBps: { min: 0, max: 3_000 },
} as const;

/* Max list sizes. The webapp has no caps of its own yet; these are generous. */
export const MAX_COUNT = {
  itemImages: 10,
  itemHashtags: 30,
  itemParams: 10,
  paramOptions: 30,
  // Option combinations (variants) per item (2.7): Size × Color… rows, each with stock and prices
  itemVariants: 100,
  categoryHashtags: 30,
  promoImages: 10,
  currencies: 3,
  // A quote's lines (4.3); the webapp's cart holds at most the same 50
  cartLines: 50,
} as const;

/* Currencies a store may use. Matches STORE_CURRENCY_CODE in both repos. */
export const CURRENCY_CODES = ["USD", "CAD", "AUD"] as const;

/* Max size of the serialized `customize` object, in characters. */
export const MAX_CUSTOMIZE_JSON = 20_000;
