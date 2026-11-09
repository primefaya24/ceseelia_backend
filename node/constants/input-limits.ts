// Server-side input limits (progress.md S.9). Lengths and ranges match the webapp's
// `src/app/core/constants/input-limits.constants.ts` (WA S.15); keep the two in sync.

/* Max string lengths, in characters. */
export const MAX_LENGTH = {
  storeName: 60,
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
} as const;

/* Numeric ranges (inclusive). */
export const NUMBER_RANGE = {
  percent: { min: 0, max: 100 },
  price: { min: 0, max: 1_000_000 },
  // -1 means "unlimited" (progress.md 2.6); the webapp only sends >= 0 until WA 2.7.
  stock: { min: -1, max: 1_000_000 },
  points: { min: 0, max: 1_000_000 },
  salesCommission: { min: 0, max: 1_000 },
} as const;

/* Max list sizes. The webapp has no caps of its own yet; these are generous. */
export const MAX_COUNT = {
  itemImages: 10,
  itemHashtags: 30,
  itemParams: 10,
  paramOptions: 30,
  categoryHashtags: 30,
  promoImages: 10,
  currencies: 3,
} as const;

/* Currencies a store may use. Matches STORE_CURRENCY_CODE in both repos. */
export const CURRENCY_CODES = ["USD", "CAD", "AUD"] as const;

/* Max size of the serialized `customize` object, in characters. */
export const MAX_CUSTOMIZE_JSON = 20_000;
