/*
 * Merchant Join Requests
 */

import { CanadaTaxSettings, isCanadaTaxSettings } from "../../tax/canada";
import {
  appConstants,
  PRIORITY,
  PRIORITY_DEFAULT,
  PRIORITY_HIGHT,
  PRIORITY_MEDIUM,
  STORE_CURRENCY_FLOAT,
  STORE_PARAM_TYPE,
} from "../../../../constants";
import {
  CURRENCY_CODES,
  MAX_COUNT,
  MAX_CUSTOMIZE_JSON,
  MAX_LENGTH,
  NUMBER_RANGE,
  STOCK_UNLIMITED,
} from "../../../../constants/input-limits";
import {
  isEmailOrEmpty,
  isHexColor,
  isImageKeyOrEmpty,
  isInRange,
  isMaxLength,
  isPhoneOrEmpty,
  isUrlOrEmpty,
  storeImageFolder,
} from "../../utils/validation";
import { isUlid } from "../../utils";
import { areVariantsValid, isStoreItemVariantPure } from "../../variants";
import { NO_PLAN, PLANS, StorePlan, StorePlanOrNone, toStorePlanOrNone } from "../../plans";

// JOIN_REQUEST, REQUEST_ID
export interface Merchant {
  joinRequesttName: string;
  joinRequesttEmail: string;
  joinRequesttPhoneNumber: string;
  joinRequesttBusinessName: string | undefined;
  joinRequesttMessage: string | undefined;
}

export function initMerchant(): Merchant {
  return {
    joinRequesttName: "",
    joinRequesttEmail: "",
    joinRequesttPhoneNumber: "",
    joinRequesttBusinessName: "",
    joinRequesttMessage: "",
  };
}

/*
 * Ceseelia Stores
 */
// APP_STORE, STORE#store_id
export interface StoreOverview {
  storeId: string;
  storeName: string;
  storeSlug: string;
  storeOrderCount: number;
  storeCompletedOrdersCount: number;
  storeCancelledOrdersCount: number;
  storeOrderLastCompletedTimestamp: number;
  storeOrderLastCompletedDateStr: string;
}

export function initStore(
  storeId: string,
  storeName: string,
  storeSlug: string
): StoreOverview {
  return {
    storeId: storeId,
    storeName: storeName,
    storeSlug: storeSlug,
    storeOrderCount: 0,
    storeCompletedOrdersCount: 0,
    storeCancelledOrdersCount: 0,
    storeOrderLastCompletedTimestamp: 0,
    storeOrderLastCompletedDateStr: appConstants.NA,
  };
}

// STORE#store_id, SETTINGS
export interface StoreSettings {
  // Merchant
  templateId: string;
  themeId: string;

  storeInfo: {
    storeName: string;
    slogan: string;
    logoUri: string;
    phoneNumber: string;
    emailaddress: string;
    /*
     * Show the email on the storefront. Optional: settings saved before it existed don't have
     * it, and missing means shown. When false the public responses leave the email out; the
     * Contact us form still reaches it (the server sends the message, the shopper never sees it).
     */
    showEmail?: boolean;
    /* Show the phone number on the storefront; same rules as showEmail (missing = shown). */
    showPhone?: boolean;
    /*
     * Public responses only (set by toPublicInventory, never saved): the store has an email, so
     * the Contact us form can be offered even when the address itself is hidden.
     */
    contactFormAvailable?: boolean;
  };

  purchaseRewards: {
    redemptionMethod: string;
    rewardsLabel: string; // i.e - PH Points

    redemptionPointAmount: number; // 350
    redemptionPointAmountValue: number; // $10, 10%

    pointsPerDollarSpent: number; // i.e - 5
    isAvailable: boolean;
  };

  socialMediaLinks: {
    websiteLink: string;
    facebook: string;
    instagram: string;
    tiktok: string;
    twitter: string;
    youtube: string;
    pinterest: string;
    etsy: string;
    whatsapp: string;
  };

  currencies: StoreCurrency[];

  general: {
    pickupAddress: string;
    discountPercent: number;
    isOnline: boolean;
    /*
     * Tax and fulfilment (4.2). Optional: settings saved before 4.2 don't have them, so read
     * them through `fulfilmentSettings`, which fills in the defaults.
     */
    /** 0–30; 0 = no tax line. */
    taxPercent?: number;
    /** Prices already include the tax (e.g. GST in Australia): the quote shows it, adds nothing. */
    pricesIncludeTax?: boolean;
    pickupEnabled?: boolean;
    deliveryEnabled?: boolean;
    /** Flat delivery fee per currency, minor units, like item prices (0 = free). */
    deliveryFees?: StoreItemPrices;
    /**
     * Tax mode (4.4). FLAT (default): `taxPercent` on every order. CANADA: GST/HST/PST/QST by
     * province from `canadaTax` and the rates in `layers/core/tax/canada.ts`; `taxPercent` and
     * `pricesIncludeTax` don't apply (Canadian prices are shown before tax).
     */
    taxMode?: TaxMode;
    canadaTax?: CanadaTaxSettings;
  };

  // Admin
  admin: {
    /**
     * Where the store's commission comes from (P.6; missing = PLAN): PLAN = its plan's default
     * (PLANS[plan].commissionMinor, a fixed fee, 0 on NOVA), CUSTOM = the fields below, set by a
     * platform admin for a negotiated deal. Read the fee with `platformFeeForStore`.
     */
    commissionSource: CommissionSource;
    /**
     * How a CUSTOM commission is worked out (5.1b; missing = FIXED). It's taken from the
     * merchant as Stripe's `application_fee_amount`, never shown to shoppers. Read the block with
     * `normalizeAdminSettings` and the fee with `platformFeeMinor`.
     * - FIXED: `salesCommissions` per order, in the order's currency.
     * - PERCENT: `commissionPercentBps` of the items after discounts, without tax and delivery,
     *   rounded half up, and at least `salesCommissions` (the per-currency minimum, 0 = none).
     */
    commissionMode: CommissionMode;
    /** Basis points (250 = 2.5%), 0–3,000; only used in PERCENT mode. */
    commissionPercentBps: number;
    /**
     * Minor units for every currency in CURRENCY_CODES ({ USD: 125, CAD: 125, AUD: 125 } = 1.25
     * each): the fee in FIXED mode, the minimum in PERCENT mode (5.1a; stores saved before 5.1a
     * have a flat `salesCommission`).
     */
    salesCommissions: Required<StoreItemPrices>;
    /**
     * An admin has suspended the store (P.2; was `isStoreLive: false` before P.2). Separate from
     * the merchant's DRAFT / LIVE `lifecycle`: a suspended store is unavailable either way.
     */
    suspended: boolean;
  };

  /**
   * Draft / review / live and the plan (P.2). Its own SETTINGS attribute: neither the merchant's
   * update-settings nor the admin form writes it; only the Go Live, billing and admin plan paths
   * will (P.4, P.5, P.8). Read it with `normalizeStoreLifecycle`; members and admins get it,
   * public responses get only `storeStatus`.
   */
  lifecycle?: StoreLifecycle;
  /**
   * Why Go Live sent the store to IN_REVIEW (P.4c), for the admin review queue. Its own
   * attribute; only admins see it (members' get-data and public data drop it).
   */
  review?: StoreReview;
  /** Stripe Billing (P.5): own attributes, written only by the billing code; never in public data. */
  subscription?: StoreSubscription;
  billingCheckout?: StoreBillingCheckout;
  /** Public responses only: the store's status (P.2); not LIVE = "Coming soon" for shoppers. */
  storeStatus?: StoreStatus;

  /**
   * The store's Stripe account (5.2): a Standard connected account owned by the merchant. Kept
   * in its own attribute so neither update-settings nor the admin form can overwrite it. Only
   * the payments routes read it; members' get-data and public responses leave it out.
   */
  payments?: StorePayments;
  /** Public responses only: the store can take payments (its Stripe account has charges on). */
  paymentsEnabled?: boolean;

  customize: any;
}

/** A store's Stripe connection (5.2). The flags are a cache of the account; Stripe is the truth. */
export interface StorePayments {
  stripeAccountId?: string;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
  /** Last time the flags were refreshed from Stripe (ms). */
  updatedAt?: number;
  /** When the merchant disconnected their account from Ceseelia (ms); a new one can be created. */
  disconnectedAt?: number;
}

/** Countries a store's Stripe account can be created in (5.2), matching the store currencies. */
export const PAYMENT_COUNTRIES = ["CA", "US", "AU"] as const;
export type PaymentCountry = (typeof PAYMENT_COUNTRIES)[number];

/**
 * A store's lifecycle (P.2). DRAFT: being built, shoppers see "Coming soon". IN_REVIEW: Go Live
 * was asked for but `runSmartStoreValidation` flagged it (P.4c), waiting for an admin. LIVE:
 * open to shoppers and checkout. Only a store with a plan is LIVE (no Free plan, 2026-11-13).
 */
export const STORE_STATUSES = ["DRAFT", "IN_REVIEW", "LIVE"] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

export interface StoreLifecycle {
  status: StoreStatus;
  /** NONE until the store subscribes (or an admin gives it a plan), and again once the plan ends. */
  plan: StorePlanOrNone;
  /** When the status last changed (ms). */
  statusChangedAt?: number;
  /** When the store first went live (ms). */
  firstLiveAt?: number;
  /** The user who created it themselves (P.3); missing for stores an admin created. */
  createdByUserId?: string;
  /**
   * Why a store that was live is a DRAFT again: PLAN_ENDED = its plan ended (cancelled, payment
   * failed past the grace, or an admin took it away). Cleared when it goes live again.
   */
  pausedReason?: StorePausedReason;
  /** A platform admin set the plan by hand (P.8, e.g. a free month of Spark); cleared when billing changes it. */
  planSetByAdmin?: boolean;
  /**
   * An admin approved the store after review (P.8) but it asked for a paid plan: it's a DRAFT
   * again, and its next Go Live skips runSmartStoreValidation and goes to checkout. Cleared live.
   */
  reviewApprovedAt?: number;
  /** An admin turned it down after review (P.8): a DRAFT again, with the reason for the merchant. */
  reviewRejection?: { message: string; at: number };
}

export const STORE_PAUSED_REASONS = ["PLAN_ENDED"] as const;
export type StorePausedReason = (typeof STORE_PAUSED_REASONS)[number];

/**
 * The store's Stripe Billing subscription (P.5), in the SETTINGS row's own `subscription`
 * attribute. Written only by the subscription sync (webhook and grace sweep), always from the
 * subscription as Stripe has it now, never from what a client sent.
 */
export interface StoreSubscription {
  subscriptionId: string;
  customerId: string;
  /** The user who subscribed (pays, and is the only one who can open the billing portal). */
  payerUserId: string;
  /** The plan the subscription's price is for (NONE: not one of our prices). */
  plan: StorePlanOrNone;
  currency: string;
  /** Stripe's status: active, past_due, unpaid, canceled, incomplete, … */
  status: string;
  /** End of the period paid for (ms), or null. */
  currentPeriodEnd: number | null;
  /** It ends at the period's end (cancelled in the portal). */
  cancelAtPeriodEnd: boolean;
  /** Payment failed for good: the plan stays until then, then it ends and the store is a draft (ms). */
  graceEndsAt: number | null;
  syncedAt: number;
}

/** A Billing Checkout started for this store and not finished yet (P.5), so a second click reuses it. */
export interface StoreBillingCheckout {
  sessionId: string;
  url: string;
  plan: StorePlan;
  userId: string;
  expiresAt: number;
}

export interface StoreReview {
  reasons: string[];
  requestedPlan: StorePlanOrNone;
  requestedAt: number;
  requestedByUserId: string | null;
}

/** A new store: a draft with no plan (P.3). */
export function initStoreLifecycle(now = Date.now()): StoreLifecycle {
  return { status: "DRAFT", plan: NO_PLAN, statusChangedAt: now };
}

/*
 * The saved lifecycle with defaults filled in, never live by accident. A store saved before P.2
 * has none and is read as a DRAFT with no plan. An unknown status is read as DRAFT, an unknown
 * plan (or the old FREE) as NONE, and a LIVE store without a plan as a DRAFT whose plan ended
 * (scripts/migrate-free-plan.mjs rewrites those rows, so conditional writes match again).
 */
export function normalizeStoreLifecycle(raw: unknown): StoreLifecycle {
  if (!isObject(raw)) return { status: "DRAFT", plan: NO_PLAN };
  const plan = toStorePlanOrNone(raw.plan);
  let status = (STORE_STATUSES as readonly string[]).includes(raw.status)
    ? (raw.status as StoreStatus)
    : "DRAFT";
  const planless = status === "LIVE" && plan === NO_PLAN;
  if (planless) status = "DRAFT";
  const out: StoreLifecycle = { status, plan };
  if (isFiniteNumber(raw.statusChangedAt)) out.statusChangedAt = raw.statusChangedAt;
  if (isFiniteNumber(raw.firstLiveAt)) out.firstLiveAt = raw.firstLiveAt;
  if (typeof raw.createdByUserId === "string") out.createdByUserId = raw.createdByUserId;
  if (planless) out.pausedReason = "PLAN_ENDED";
  else if ((STORE_PAUSED_REASONS as readonly string[]).includes(raw.pausedReason)) {
    out.pausedReason = raw.pausedReason as StorePausedReason;
  }
  if (raw.planSetByAdmin === true) out.planSetByAdmin = true;
  if (isFiniteNumber(raw.reviewApprovedAt)) out.reviewApprovedAt = raw.reviewApprovedAt;
  if (isObject(raw.reviewRejection) && typeof raw.reviewRejection.message === "string" && isFiniteNumber(raw.reviewRejection.at)) {
    out.reviewRejection = { message: raw.reviewRejection.message, at: raw.reviewRejection.at };
  }
  return out;
}

/** Where a store's commission comes from (P.6): its plan's default, or an admin's custom deal. */
export const COMMISSION_SOURCES = ["PLAN", "CUSTOM"] as const;
export type CommissionSource = (typeof COMMISSION_SOURCES)[number];

/** How the platform commission is worked out (5.1b). */
export const COMMISSION_MODES = ["FIXED", "PERCENT"] as const;
export type CommissionMode = (typeof COMMISSION_MODES)[number];

/** How a store charges tax (4.4). */
export const TAX_MODES = ["FLAT", "CANADA"] as const;
export type TaxMode = (typeof TAX_MODES)[number];

export function initStoreSettings(): StoreSettings {
  return {
    // Merchant
    templateId: appConstants.STORE_TEMPLATE_DEFAULT,
    themeId: appConstants.STORE_THEME_DEFAULT,
    customize: {},
    storeInfo: {
      storeName: "",
      slogan: "",
      logoUri: "",
      phoneNumber: "",
      emailaddress: "",
    },
    purchaseRewards: {
      isAvailable: false,
      rewardsLabel: "",
      pointsPerDollarSpent: 0,
      redemptionMethod:
        appConstants.STORE_REWARDS_REDEMPTION_METHOD_POINTS_TO_MONEY,
      redemptionPointAmount: 0,
      redemptionPointAmountValue: 0,
    },
    socialMediaLinks: {
      websiteLink: "",
      facebook: "",
      instagram: "",
      tiktok: "",
      twitter: "",
      youtube: "",
      pinterest: "",
      etsy: "",
      whatsapp: "",
    },
    currencies: [initStoreCurrency()],
    general: {
      pickupAddress: "",
      discountPercent: 0,
      isOnline: false,
      taxPercent: 0,
      pricesIncludeTax: false,
      pickupEnabled: true,
      deliveryEnabled: false,
      deliveryFees: {},
    },

    // Admin
    admin: {
      commissionSource: "PLAN",
      commissionMode: "FIXED",
      commissionPercentBps: 0,
      salesCommissions: defaultSalesCommissions(),
      suspended: false,
    },
    lifecycle: initStoreLifecycle(),
  };
}

/** The default commission (1.25) in every currency. */
export function defaultSalesCommissions(): Required<StoreItemPrices> {
  return Object.fromEntries(
    CURRENCY_CODES.map((c) => [c, appConstants.STORE_DEFAULT_SALES_COMMISSION_MINOR])
  ) as Required<StoreItemPrices>;
}

/** A commission for every allowed currency, each a whole number of cents in range (5.1a). */
export function isSalesCommissionsValid(v: unknown): v is Required<StoreItemPrices> {
  if (!isObject(v)) return false;
  const keys = Object.keys(v);
  return (
    keys.length === CURRENCY_CODES.length &&
    CURRENCY_CODES.every(
      (c) => Number.isInteger(v[c]) && isInRange(v[c] as number, NUMBER_RANGE.salesCommissionMinor)
    )
  );
}

/** A commission percentage in basis points: a whole number in range (5.1b). */
export function isCommissionPercentBpsValid(v: unknown): v is number {
  return Number.isInteger(v) && isInRange(v as number, NUMBER_RANGE.commissionPercentBps);
}

/*
 * The saved admin block with defaults filled in. `isStoreLive` (before P.2) becomes `suspended`.
 * A missing or unknown mode is FIXED and a missing
 * or bad percentage is 0 (blocks saved before 5.1b). Blocks saved before 5.1a have a flat
 * `salesCommission` in major units with no currency; it becomes that amount in every currency.
 * Missing or bad per-currency values fall back to the default.
 */
export function normalizeAdminSettings(raw: unknown): StoreSettings["admin"] {
  const r = isObject(raw) ? raw : {};
  const legacy =
    isFiniteNumber(r.salesCommission) && isInRange(Math.round(r.salesCommission * 100), NUMBER_RANGE.salesCommissionMinor)
      ? Math.round(r.salesCommission * 100)
      : null;
  const saved = isObject(r.salesCommissions) ? r.salesCommissions : {};
  const salesCommissions = defaultSalesCommissions();
  for (const c of CURRENCY_CODES) {
    const v = saved[c];
    if (Number.isInteger(v) && isInRange(v, NUMBER_RANGE.salesCommissionMinor)) salesCommissions[c] = v;
    else if (legacy !== null) salesCommissions[c] = legacy;
  }
  return {
    commissionSource: r.commissionSource === "CUSTOM" ? "CUSTOM" : "PLAN",
    commissionMode: r.commissionMode === "PERCENT" ? "PERCENT" : "FIXED",
    commissionPercentBps: isCommissionPercentBpsValid(r.commissionPercentBps) ? r.commissionPercentBps : 0,
    salesCommissions,
    // Before P.2 a suspension was `isStoreLive: false`.
    suspended: r.suspended === true || (r.suspended === undefined && r.isStoreLive === false),
  };
}

/** The parts of a quote (4.1 `Quote`) the platform fee is worked out from. */
export interface FeeQuote {
  currency: string;
  /** Items before discounts. */
  subtotalMinor: number;
  discountMinor: number;
  /** In FLAT mode with tax-inclusive prices, the items include tax at this rate. */
  pricesIncludeTax: boolean;
  taxPercent: number;
  /** What the shopper pays. */
  totalMinor: number;
}

/*
 * The fee from an admin block's CUSTOM fields (5.1b), whatever its `commissionSource`: callers
 * use platformFeeForStore, which picks the plan's default or these. Always from the server's
 * own re-quote and the stored admin block, never from anything the client sends.
 * FIXED: the store's amount in the order's currency. PERCENT: `commissionPercentBps` of
 * `commissionBaseMinor`, rounded half up, raised to the currency's minimum. Either way never more
 * than the order total (Stripe rejects a fee above the charge) and never below 0.
 */
export function platformFeeMinor(admin: StoreSettings["admin"] | undefined, quote: FeeQuote): number {
  const a = normalizeAdminSettings(admin);
  const fixed =
    a.salesCommissions[quote.currency as keyof typeof a.salesCommissions] ??
    appConstants.STORE_DEFAULT_SALES_COMMISSION_MINOR;
  const fee =
    a.commissionMode === "PERCENT"
      ? Math.max(fixed, bpsOf(commissionBaseMinor(quote), a.commissionPercentBps))
      : fixed;
  return Math.max(0, Math.min(fee, Math.floor(quote.totalMinor)));
}

/** The commission a store is charged, as `platformFeeMinor` reads it (P.6). */
export interface CommissionInEffect {
  source: CommissionSource;
  plan: StorePlanOrNone;
  commissionMode: CommissionMode;
  commissionPercentBps: number;
  salesCommissions: Record<(typeof CURRENCY_CODES)[number], number>;
}

/*
 * The commission in effect for a store (P.6): the admin's CUSTOM one if set, else the plan's
 * default as a fixed fee per order (NOVA = 0). This is also what an order copies (5.4c), so a
 * later plan or admin change never alters an order in progress. A store with no plan isn't live
 * and takes no orders; if one ever did, it pays SPARK's fee, never nothing.
 */
export function commissionInEffect(
  admin: StoreSettings["admin"] | undefined,
  plan: StorePlanOrNone
): CommissionInEffect {
  const a = normalizeAdminSettings(admin);
  if (a.commissionSource === "CUSTOM") {
    return {
      source: "CUSTOM",
      plan,
      commissionMode: a.commissionMode,
      commissionPercentBps: a.commissionPercentBps,
      salesCommissions: a.salesCommissions,
    };
  }
  const known = toStorePlanOrNone(plan);
  const p = PLANS[known === NO_PLAN ? "SPARK" : known];
  return {
    source: "PLAN",
    plan: known,
    commissionMode: "FIXED",
    commissionPercentBps: 0,
    salesCommissions: { ...p.commissionMinor },
  };
}

/*
 * The platform fee for one order of this store (P.6, the 5.4c `application_fee_amount`): the
 * commission in effect, worked out by platformFeeMinor (capped at the total, never below 0).
 * `plan` is the store's lifecycle plan, read on the server.
 */
export function platformFeeForStore(
  admin: StoreSettings["admin"] | undefined,
  plan: StorePlanOrNone,
  quote: FeeQuote
): number {
  return feeFromCommission(commissionInEffect(admin, plan), quote);
}

/* The fee for an order from a commission (the store's now, or the copy saved on an order). */
export function feeFromCommission(c: CommissionInEffect, quote: FeeQuote): number {
  return platformFeeMinor(
    {
      commissionSource: "CUSTOM",
      commissionMode: c.commissionMode,
      commissionPercentBps: c.commissionPercentBps,
      salesCommissions: c.salesCommissions,
      suspended: false,
    },
    quote
  );
}

/*
 * What a percentage commission is taken on (5.1b): the items after discounts, without delivery
 * and without tax. Tax-inclusive prices have their tax taken out (half up), so the platform
 * never takes a cut of the sales tax the merchant collects.
 */
export function commissionBaseMinor(quote: FeeQuote): number {
  const items = Math.max(0, Math.floor(quote.subtotalMinor - quote.discountMinor));
  if (!quote.pricesIncludeTax || !(quote.taxPercent > 0)) return items;
  // items × 100 / (100 + rate), with the rate in thousandths of a percent (as percentOf does).
  const milli = BigInt(Math.round(quote.taxPercent * 1000));
  const den = BigInt(100_000) + milli;
  return Number((BigInt(items) * BigInt(100_000) * BigInt(2) + den) / (den * BigInt(2)));
}

/** `bps` basis points of `amountMinor`, rounded half up, in BigInt so large orders stay exact. */
function bpsOf(amountMinor: number, bps: number): number {
  if (bps <= 0 || amountMinor <= 0) return 0;
  return Number((BigInt(amountMinor) * BigInt(bps) + BigInt(5_000)) / BigInt(10_000));
}

const isObject = (v: unknown): v is Record<string, any> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const allStrings = (obj: Record<string, any>, keys: string[]): boolean =>
  keys.every((k) => typeof obj[k] === "string");

const STORE_INFO_STRING_KEYS = ["storeName", "slogan", "logoUri", "phoneNumber", "emailaddress"];
const SOCIAL_MEDIA_KEYS = [
  "websiteLink", "facebook", "instagram", "tiktok", "twitter",
  "youtube", "pinterest", "etsy", "whatsapp",
];

/*
 * Type checks for the merchant-editable settings. Extra (UI-only) fields are tolerated.
 * `admin` is intentionally not checked: it is not persisted by update-settings.
 */
export function isStoreSettingsPure(storeSettings: StoreSettings): boolean {
  const s: any = storeSettings;
  if (!isObject(s)) return false;
  if (typeof s.templateId !== "string" || typeof s.themeId !== "string") return false;

  if (!isObject(s.storeInfo) || !allStrings(s.storeInfo, STORE_INFO_STRING_KEYS)) return false;
  for (const key of ["showEmail", "showPhone"]) {
    if (s.storeInfo[key] !== undefined && typeof s.storeInfo[key] !== "boolean") return false;
  }

  const r = s.purchaseRewards;
  if (
    !isObject(r) ||
    typeof r.redemptionMethod !== "string" ||
    typeof r.rewardsLabel !== "string" ||
    !isFiniteNumber(r.redemptionPointAmount) ||
    !isFiniteNumber(r.redemptionPointAmountValue) ||
    !isFiniteNumber(r.pointsPerDollarSpent) ||
    typeof r.isAvailable !== "boolean"
  ) return false;

  if (!isObject(s.socialMediaLinks) || !allStrings(s.socialMediaLinks, SOCIAL_MEDIA_KEYS)) return false;

  if (!Array.isArray(s.currencies) || !s.currencies.every(isStoreCurrencyPure)) return false;

  const g = s.general;
  if (
    !isObject(g) ||
    typeof g.pickupAddress !== "string" ||
    !isFiniteNumber(g.discountPercent) ||
    typeof g.isOnline !== "boolean" ||
    (g.taxPercent !== undefined && !isFiniteNumber(g.taxPercent)) ||
    (g.pricesIncludeTax !== undefined && typeof g.pricesIncludeTax !== "boolean") ||
    (g.pickupEnabled !== undefined && typeof g.pickupEnabled !== "boolean") ||
    (g.deliveryEnabled !== undefined && typeof g.deliveryEnabled !== "boolean") ||
    (g.deliveryFees !== undefined && !isObject(g.deliveryFees)) ||
    (g.taxMode !== undefined && typeof g.taxMode !== "string") ||
    (g.canadaTax !== undefined && !isObject(g.canadaTax))
  ) return false;

  if (s.customize !== undefined && !isObject(s.customize)) return false;

  return true;
}

const SOCIAL_URL_KEYS = [
  "websiteLink", "facebook", "instagram", "tiktok", "twitter", "youtube", "pinterest", "etsy",
] as const;

/*
 * Value checks (call only after isStoreSettingsPure). `storeId` must already be a checked ULID:
 * image keys must sit in this store's own folders.
 */
export function isStoreSettingsValid(storeSettings: StoreSettings, storeId: string): boolean {
  const s = storeSettings;
  if (s.templateId.length === 0 || s.themeId.length === 0) return false;
  if (!isMaxLength(s.templateId, MAX_LENGTH.templateId) || !isMaxLength(s.themeId, MAX_LENGTH.templateId)) {
    return false;
  }

  // Store info
  const info = s.storeInfo;
  if (
    !isMaxLength(info.storeName, MAX_LENGTH.storeName) ||
    !isMaxLength(info.slogan, MAX_LENGTH.storeSlogan) ||
    !isMaxLength(info.emailaddress, MAX_LENGTH.email) ||
    !isEmailOrEmpty(info.emailaddress) ||
    !isMaxLength(info.phoneNumber, MAX_LENGTH.phone) ||
    !isPhoneOrEmpty(info.phoneNumber) ||
    !isImageKeyOrEmpty(info.logoUri, storeImageFolder.logo(storeId))
  ) return false;

  // Rewards
  const r = s.purchaseRewards;
  // TODO(Stage 7): unify — the webapp saves REWARDS_REDEMPTION_*, the backend default is POINTS_TO_*
  const redemptionMethods = [
    appConstants.STORE_REWARDS_REDEMPTION_METHOD_POINTS_TO_MONEY,
    appConstants.STORE_REWARDS_REDEMPTION_METHOD_POINTS_TO_DISCOUNT,
    "REWARDS_REDEMPTION_DOLLAR",
    "REWARDS_REDEMPTION_DISCOUNT",
  ];
  if (!redemptionMethods.includes(r.redemptionMethod)) return false;
  const isPercentReward =
    r.redemptionMethod === appConstants.STORE_REWARDS_REDEMPTION_METHOD_POINTS_TO_DISCOUNT ||
    r.redemptionMethod === "REWARDS_REDEMPTION_DISCOUNT";
  if (
    !isMaxLength(r.rewardsLabel, MAX_LENGTH.rewardsLabel) ||
    !isInRange(r.redemptionPointAmount, NUMBER_RANGE.points) ||
    !Number.isInteger(r.redemptionPointAmount) ||
    !isInRange(r.redemptionPointAmountValue, isPercentReward ? NUMBER_RANGE.percent : NUMBER_RANGE.price) ||
    !isInRange(r.pointsPerDollarSpent, NUMBER_RANGE.points)
  ) return false;

  // Social links
  const links = s.socialMediaLinks;
  if (!SOCIAL_URL_KEYS.every((k) => isMaxLength(links[k], MAX_LENGTH.url) && isUrlOrEmpty(links[k]))) {
    return false;
  }
  if (!isMaxLength(links.whatsapp, MAX_LENGTH.phone) || !isPhoneOrEmpty(links.whatsapp)) return false;

  // Currencies: 1-3 from the allow-list, no duplicates, exactly one default
  if (
    s.currencies.length === 0 ||
    s.currencies.length > MAX_COUNT.currencies ||
    !s.currencies.every(isStoreCurrencyValid)
  ) return false;
  const codes = s.currencies.map((c) => c.currencyCode);
  if (new Set(codes).size !== codes.length) return false;
  if (s.currencies.filter((c) => c.currencyIsDefault).length !== 1) return false;

  // General
  if (!isMaxLength(s.general.pickupAddress, MAX_LENGTH.pickupAddress)) return false;
  if (!isInRange(s.general.discountPercent, NUMBER_RANGE.percent)) return false;
  if (!isFulfilmentValid(s)) return false;

  return isStoreCustomizeValid(s, storeId);
}

/*
 * Tax and fulfilment, with 4.2's defaults filled in for settings saved before 4.2. Read these
 * fields through here, never straight off `general`.
 */
export function fulfilmentSettings(general: Partial<StoreSettings["general"]> | undefined) {
  return {
    taxPercent: general?.taxPercent ?? 0,
    pricesIncludeTax: general?.pricesIncludeTax ?? false,
    pickupEnabled: general?.pickupEnabled ?? true,
    deliveryEnabled: general?.deliveryEnabled ?? false,
    deliveryFees: (general?.deliveryFees ?? {}) as StoreItemPrices,
    taxMode: (general?.taxMode ?? "FLAT") as TaxMode,
    canadaTax: general?.canadaTax ?? null,
  };
}

/*
 * 4.2: tax 0–30%; pickup or delivery (at least one); with delivery on, a whole, in-range fee for
 * every currency the store offers. Fees for other known currencies are allowed (a currency can
 * be removed and added back).
 */
function isFulfilmentValid(s: StoreSettings): boolean {
  const f = fulfilmentSettings(s.general);
  if (!isInRange(f.taxPercent, NUMBER_RANGE.taxPercent)) return false;
  if (!(TAX_MODES as readonly string[]).includes(f.taxMode)) return false;
  // Canada mode (4.4): a known home province, registrations only in provinces that have their
  // own sales tax, and prices shown before tax.
  if (f.taxMode === "CANADA" && (!isCanadaTaxSettings(f.canadaTax) || f.pricesIncludeTax)) return false;
  if (!f.pickupEnabled && !f.deliveryEnabled) return false;
  for (const [code, fee] of Object.entries(f.deliveryFees)) {
    if (!(CURRENCY_CODES as readonly string[]).includes(code)) return false;
    if (!Number.isInteger(fee) || !isInRange(fee as number, NUMBER_RANGE.priceMinor)) return false;
  }
  if (f.deliveryEnabled && !s.currencies.every((c) => Number.isInteger(f.deliveryFees[c.currencyCode as keyof StoreItemPrices]))) {
    return false;
  }
  return true;
}

/*
 * `customize` is template-specific. Cap its size for every template, and check the default
 * (t0) template's fields when they're present. UI-only extras (e.g. `imageFile: null`) are allowed.
 */
function isStoreCustomizeValid(s: StoreSettings, storeId: string): boolean {
  const c = s.customize;
  if (c === undefined) return true;
  if (JSON.stringify(c).length > MAX_CUSTOMIZE_JSON) return false;
  if (s.templateId !== appConstants.STORE_TEMPLATE_DEFAULT) return true;

  const color = c.colorTheme?.primaryColor;
  if (c.colorTheme !== undefined && (!isObject(c.colorTheme) || (color !== undefined && (typeof color !== "string" || !isHexColor(color))))) {
    return false;
  }

  if (c.header !== undefined) {
    const uri = c.header?.headerImageStripUri;
    if (!isObject(c.header) || (uri !== undefined && (typeof uri !== "string" || !isImageKeyOrEmpty(uri, storeImageFolder.header(storeId))))) {
      return false;
    }
  }

  const promo = c.promoContent;
  if (promo !== undefined) {
    if (!isObject(promo)) return false;
    if (promo.runnerText !== undefined && (typeof promo.runnerText !== "string" || !isMaxLength(promo.runnerText, MAX_LENGTH.promoRunnerText))) {
      return false;
    }
    if (promo.promoImages !== undefined) {
      if (!Array.isArray(promo.promoImages) || promo.promoImages.length > MAX_COUNT.promoImages) return false;
      const folder = storeImageFolder.promo(storeId);
      const ok = promo.promoImages.every(
        (img: unknown) =>
          isObject(img) &&
          (img.imageUri === undefined || (typeof img.imageUri === "string" && isImageKeyOrEmpty(img.imageUri, folder)))
      );
      if (!ok) return false;
    }
  }
  return true;
}

export function isStoreCurrencyPure(currency: StoreCurrency): boolean {
  return (
    isObject(currency) &&
    typeof currency.currencyCode === "string" &&
    typeof currency.currencySign === "string" &&
    typeof currency.currencyFloat === "string" &&
    typeof currency.currencyIsDefault === "boolean"
  );
}

export function isStoreCurrencyValid(currency: StoreCurrency): boolean {
  return (
    (CURRENCY_CODES as readonly string[]).includes(currency.currencyCode) &&
    currency.currencySign.length > 0 &&
    isMaxLength(currency.currencySign, MAX_LENGTH.currencySign) &&
    (currency.currencyFloat === appConstants.STORE_CURRENCY_POSITION_LEFT ||
      currency.currencyFloat === appConstants.STORE_CURRENCY_POSITION_RIGHT)
  );
}

export interface StoreCurrency {
  currencyCode: string;
  currencySign: string;
  currencyFloat: STORE_CURRENCY_FLOAT;
  currencyIsDefault: boolean;
}

export function initStoreCurrency(): StoreCurrency {
  return {
    currencyCode: "USD",
    currencySign: "$",
    currencyFloat: "LEFT",
    currencyIsDefault: true,
  };
}

/*
 * Store Category
 */
// STORE#STORE_ID, CATEGORY#CATEGORY_ID
export interface StoreCategory {
  storeCategoriyId: string;
  storeCategoriyPriority: PRIORITY;
  storeCategoryName: string;
  storeCategoryBannerUri: string;
  storeCategoryIsActive: boolean;
  storeCategoryDiscountPercent: number;
  storeCategoriyHashtags: StoreCategoryHashtag[];
  storeCategoryItemCount: number;
}

export function initStoreCategory(
  storeCategoriyId: string,
  storeCategoryName: string
): StoreCategory {
  return {
    storeCategoriyId: storeCategoriyId,
    storeCategoriyPriority: PRIORITY_DEFAULT,
    storeCategoryName: storeCategoryName,
    storeCategoryBannerUri: "",
    storeCategoryIsActive: true,
    storeCategoryDiscountPercent: 0,
    storeCategoriyHashtags: [],
    storeCategoryItemCount: 0,
  };
}

export function isStoreCategoryPure(storeCategory: StoreCategory): boolean {
  if (!isObject(storeCategory)) return false;
  const hashtags = storeCategory.storeCategoriyHashtags;
  return (
    typeof storeCategory.storeCategoriyPriority === "string" &&
    typeof storeCategory.storeCategoryName === "string" &&
    typeof storeCategory.storeCategoryBannerUri === "string" &&
    typeof storeCategory.storeCategoryIsActive === "boolean" &&
    typeof storeCategory.storeCategoryDiscountPercent === "number" &&
    Array.isArray(hashtags) &&
    hashtags.every((hashtag) => isObject(hashtag) && isStoreCategoryHashtagPure(hashtag)) &&
    typeof storeCategory.storeCategoryItemCount === "number"
  );
}

const PRIORITIES: string[] = [PRIORITY_HIGHT, PRIORITY_MEDIUM, PRIORITY_DEFAULT];

/*
 * Value checks (call only after isStoreCategoryPure). `categoryId` is the existing category's ID
 * on update, or undefined on create; a new category can't have a banner yet (it's uploaded under
 * the ID the create returns).
 */
export function isStoreCategoryValid(
  storeCategory: StoreCategory,
  storeId: string,
  categoryId: string | undefined
): boolean {
  const hashtags = storeCategory.storeCategoriyHashtags;
  const banner = storeCategory.storeCategoryBannerUri;
  return (
    storeCategory.storeCategoryName.length > 0 &&
    isMaxLength(storeCategory.storeCategoryName, MAX_LENGTH.categoryName) &&
    PRIORITIES.includes(storeCategory.storeCategoriyPriority) &&
    isInRange(storeCategory.storeCategoryDiscountPercent, NUMBER_RANGE.percent) &&
    (categoryId
      ? isImageKeyOrEmpty(banner, storeImageFolder.categoryBanner(storeId, categoryId))
      : banner === "") &&
    hashtags.length <= MAX_COUNT.categoryHashtags &&
    hashtags.every((hashtag) => isStoreCategoryHashtagValid(hashtag))
  );
}

export interface StoreCategoryHashtag {
  id: string;
  value: string;
}

export function isStoreCategoryHashtagPure(
  storeCategoryHashtag: StoreCategoryHashtag
): boolean {
  return (
    typeof storeCategoryHashtag.id === "string" &&
    typeof storeCategoryHashtag.value === "string"
  );
}

export function isStoreCategoryHashtagValid(
  storeCategoryHashtag: StoreCategoryHashtag
): boolean {
  return (
    storeCategoryHashtag.id.length > 0 &&
    isMaxLength(storeCategoryHashtag.id, MAX_LENGTH.hashtagId) &&
    storeCategoryHashtag.value.length > 0 &&
    isMaxLength(storeCategoryHashtag.value, MAX_LENGTH.hashtag)
  );
}

/*
 * Store Items
 */
// STORE#STORE_ID, ITEM#ITEM_ID
export interface StoreItem {
  storeItemId: string;
  storeItemCategoryId: string;
  storeItemImageUris: string[];
  storeItemName: string;
  /* STOCK_UNLIMITED (-1), or a tracked whole number >= 0 where 0 = sold out (2.6). */
  storeItemStock: number;
  /*
   * Price per currency code in minor units (2.5): { USD: 6500, CAD: 8900 } = $65.00 / CA$89.00.
   * The merchant sets each one; nothing is converted. A currency the store offers but the item
   * has no price in is a currency the item isn't sold in.
   */
  storeItemPrices: StoreItemPrices;
  storeItemDescription: string;
  storeItemIsActive: boolean;
  storeItemHashtagIds: string[];
  storeItemDiscountPercent: number;
  storeItemCustomParams: StoreParameter[];
  /*
   * Stock and prices per option combination (2.7, `layers/core/variants`): one row per
   * combination of the single-choice params' options. Empty (or missing, on items saved before
   * 2.7) when the item has no single-choice params. With rows, `storeItemStock` and
   * `storeItemPrices` are worked out from them on save (sum / lowest price).
   */
  storeItemVariants?: StoreItemVariant[];
}

/* One option combination of an item (2.7), e.g. { Size: "M", Color: "White" }. */
export interface StoreItemVariant {
  /* The option picked for each single-choice param, by param label. */
  storeVariantOptions: Record<string, string>;
  /* STOCK_UNLIMITED (-1) or a tracked count >= 0, like storeItemStock. */
  storeVariantStock: number;
  /* Minor units per currency, like storeItemPrices; a missing currency = not sold in it. */
  storeVariantPrices: StoreItemPrices;
  /* False: this combination isn't sold (not made); shoppers can't pick it. */
  storeVariantIsActive: boolean;
}

export function isStoreItemPure(storeItem: StoreItem): boolean {
  if (!isObject(storeItem)) return false;
  const i = storeItem;
  return (
    typeof i.storeItemCategoryId === "string" &&
    Array.isArray(i.storeItemImageUris) &&
    i.storeItemImageUris.every((uri) => typeof uri === "string") &&
    typeof i.storeItemName === "string" &&
    typeof i.storeItemStock === "number" &&
    isObject(i.storeItemPrices) &&
    Object.values(i.storeItemPrices).every((v) => typeof v === "number") &&
    typeof i.storeItemDescription === "string" &&
    typeof i.storeItemIsActive === "boolean" &&
    Array.isArray(i.storeItemHashtagIds) &&
    i.storeItemHashtagIds.every((id) => typeof id === "string") &&
    typeof i.storeItemDiscountPercent === "number" &&
    Array.isArray(i.storeItemCustomParams) &&
    i.storeItemCustomParams.every((p) => isObject(p) && isStoreParameterPure(p)) &&
    (i.storeItemVariants === undefined ||
      (Array.isArray(i.storeItemVariants) && i.storeItemVariants.every(isStoreItemVariantPure)))
  );
}

/*
 * Value checks (call only after isStoreItemPure, on the item as it will be saved: run it through
 * `withVariantTotals` first so a variant item's stock and prices are the ones worked out from its
 * rows). `itemId` is the existing item's ID on update, or undefined on create; a new item can't
 * have images yet (they're uploaded under the ID the create returns).
 */
export function isStoreItemValid(
  storeItem: StoreItem,
  storeId: string,
  itemId: string | undefined
): boolean {
  const i = storeItem;
  const imageFolder = itemId ? storeImageFolder.item(storeId, itemId) : undefined;
  return (
    isUlid(i.storeItemCategoryId) &&
    i.storeItemName.length > 0 &&
    isMaxLength(i.storeItemName, MAX_LENGTH.itemName) &&
    isMaxLength(i.storeItemDescription, MAX_LENGTH.itemDescription) &&
    isStoreItemPricesValid(i.storeItemPrices) &&
    isInRange(i.storeItemStock, NUMBER_RANGE.stock) &&
    Number.isInteger(i.storeItemStock) &&
    isInRange(i.storeItemDiscountPercent, NUMBER_RANGE.percent) &&
    i.storeItemImageUris.length <= MAX_COUNT.itemImages &&
    i.storeItemImageUris.every(
      (uri) => uri.length > 0 && imageFolder !== undefined && isImageKeyOrEmpty(uri, imageFolder)
    ) &&
    i.storeItemHashtagIds.length <= MAX_COUNT.itemHashtags &&
    i.storeItemHashtagIds.every((id) => id.length > 0 && isMaxLength(id, MAX_LENGTH.hashtagId)) &&
    i.storeItemCustomParams.length <= MAX_COUNT.itemParams &&
    i.storeItemCustomParams.every(isStoreParameterValid) &&
    areVariantsValid(i, isStoreItemPricesValid)
  );
}

/* Stock rule (2.6): unlimited never runs out; a tracked count needs at least `quantity`. */
export const isUnlimitedStock = (stock: number): boolean => stock === STOCK_UNLIMITED;

export function hasStockFor(stock: number, quantity = 1): boolean {
  if (!Number.isInteger(quantity) || quantity < 1) return false;
  return isUnlimitedStock(stock) || (Number.isInteger(stock) && stock >= quantity);
}

export type StoreItemPrices = Partial<Record<(typeof CURRENCY_CODES)[number], number>>;

/* 1-3 prices, keyed by allowed currency codes, each a whole number of cents in range. */
export function isStoreItemPricesValid(prices: StoreItemPrices): boolean {
  const entries = Object.entries(prices);
  return (
    entries.length > 0 &&
    entries.length <= MAX_COUNT.currencies &&
    entries.every(
      ([code, cents]) =>
        (CURRENCY_CODES as readonly string[]).includes(code) &&
        Number.isInteger(cents) &&
        isInRange(cents as number, NUMBER_RANGE.priceMinor)
    )
  );
}

export interface StoreParameter {
  storeParamLabel: string;
  storeParamType: STORE_PARAM_TYPE;
  storeParamIsMandatory: boolean;
  storeParamOptions: string[];
}

export function isStoreParameterPure(storeParameter: StoreParameter): boolean {
  return (
    typeof storeParameter.storeParamLabel === "string" &&
    typeof storeParameter.storeParamType === "string" &&
    typeof storeParameter.storeParamIsMandatory === "boolean" &&
    Array.isArray(storeParameter.storeParamOptions) &&
    storeParameter.storeParamOptions.every((o) => typeof o === "string")
  );
}

export function isStoreParameterValid(storeParameter: StoreParameter): boolean {
  const label = storeParameter.storeParamLabel;
  if (label.length === 0 || !isMaxLength(label, MAX_LENGTH.paramLabel)) {
    return false;
  }
  const options = storeParameter.storeParamOptions;
  if (
    options.length > MAX_COUNT.paramOptions ||
    !options.every((o) => o.length > 0 && isMaxLength(o, MAX_LENGTH.paramOption))
  ) {
    return false;
  }
  if (
    storeParameter.storeParamType !== "SINGLE_SELECT" &&
    storeParameter.storeParamType !== "MULTI_SELECT"
  ) {
    return false;
  }
  return true;
}

export interface StoreInventoryData {
  categories: StoreCategory[];
  items: StoreItem[];
  settings: StoreSettings;
}

export function initStoreInventoryData(): StoreInventoryData {
  return {
    categories: [],
    items: [],
    settings: initStoreSettings(),
  };
}

/*
 * Store Members
 */
// STORE#STORE_ID, MEMBER#MEMBER_ID
export interface StoreMember {
  storeMemberId: string;
  storeMemberFirstName: string;
  storeMemberLastName: string;
  storeMemberEmail: string;
  storeMemberPhoneNumber: string;
  storeMemberPermission: "ADMIN" | "MERCHANT";
  storeMemberUpdatedAt: number;
  storeMemberCreatedAt: number;
}

/*
 * Store Orders
 */
// STORE#STORE_ID, ORDER#CREATE_AT_TIMESTAMP (For Sales acitivty graph), (TEST_ORDER#ORDER_ID)
export interface StoreOrder {
  storeOrderId: string;
  storeOrderCode: string;
  storeOrderType: "DELIVERY" | "PICKUP";
  storeOrderStatus: boolean;
  storeOrderStoreName: string;
  storeOrderCustomerName: string;
  storeOrderCustomerEmailAddress: string;
  storeOrderCustomerPhoneNumber: string;
  storeOrderCustomerShippingCountry: string;
  storeOrderCustomerShippingState: string;
  storeOrderCustomerShippingCity: string;
  storeOrderCustomerShippingAddressStreetNumber: string;
  storeOrderCustomerAuthenticatedUserId: string;
  storeOrderStatusCustomerUpdate: boolean;
  storeOrderItems: StoreOrderItem[];
  storeOrderNote: string;
  storeOrderSubtotalAmount: number;
  storeOrderDeliveryAmount: number;
  storeOrderHandlingAmount: number;
  storeOrderTaxAmount: number;
  storeOrderCreatedAt: number;
  storeOrderUpdatedAt: number;
}

export interface StoreOrderItem {
  id: string;
  price: number;
  parameters: {
    id: string;
    label: string;
    value: string;
  }[];
}

// APP, ORDER#CREATE_AT_TIMESTAMP#STORE#STORE_ID (For Sales acitivty graph)
