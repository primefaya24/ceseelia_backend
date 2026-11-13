import { CURRENCY_CODES } from "../../../constants/input-limits";
import { PAID_PLANS_ENABLED } from "../../../config";

/*
 * Store plans (progress.md P.1, decided with the owner 2026-11-12). Plans are per store, and an
 * account can have at most one live FREE store. This file is the only place plan prices,
 * commissions and limits are written down: routes, the fee (P.6) and the order limit (P.7) read
 * them from here, and the webapp gets them from the API, never from its own copy.
 *
 * Amounts are whole cents per currency. A subscription is billed in the currency of the store's
 * Stripe account country (assumption A1 in progress.md §6a).
 */

export const STORE_PLANS = ["FREE", "SPARK", "NOVA"] as const;
export type StorePlan = (typeof STORE_PLANS)[number];

type CurrencyCode = (typeof CURRENCY_CODES)[number];
export type PerCurrency = Record<CurrencyCode, number>;

export interface PlanDefinition {
  id: StorePlan;
  name: string;
  /** Monthly subscription price, cents per currency (0 = no subscription). */
  monthlyPriceMinor: PerCurrency;
  /** Default platform commission per order, cents per currency (FIXED; an admin can override, P.6). */
  commissionMinor: PerCurrency;
  /** Paid orders per calendar month (UTC), or null for unlimited (P.7). */
  monthlyOrderLimit: number | null;
  /** Custom domains are offered on this plan ("coming soon" until 9.8). */
  customDomain: boolean;
}

export const PLANS: Readonly<Record<StorePlan, Readonly<PlanDefinition>>> = Object.freeze({
  FREE: Object.freeze({
    id: "FREE",
    name: "Free",
    monthlyPriceMinor: Object.freeze({ CAD: 0, AUD: 0, USD: 0 }),
    commissionMinor: Object.freeze({ CAD: 295, AUD: 295, USD: 245 }),
    monthlyOrderLimit: 30,
    customDomain: false,
  }),
  SPARK: Object.freeze({
    id: "SPARK",
    name: "Spark",
    monthlyPriceMinor: Object.freeze({ CAD: 2500, AUD: 2500, USD: 1900 }),
    commissionMinor: Object.freeze({ CAD: 195, AUD: 195, USD: 145 }),
    monthlyOrderLimit: null,
    customDomain: true,
  }),
  NOVA: Object.freeze({
    id: "NOVA",
    name: "Nova",
    monthlyPriceMinor: Object.freeze({ CAD: 4900, AUD: 4900, USD: 3900 }),
    commissionMinor: Object.freeze({ CAD: 0, AUD: 0, USD: 0 }),
    monthlyOrderLimit: null,
    customDomain: true,
  }),
});

/**
 * Whether a plan can be picked today. SPARK and NOVA need Stripe Billing set up (P.5), switched
 * on with PAID_PLANS_ENABLED; while it's off they're listed but refused with PLAN_NOT_AVAILABLE,
 * and the webapp marks them "coming soon".
 */
export function isPlanAvailable(id: StorePlan): boolean {
  return !isPaidPlan(id) || paidPlansOn;
}

let paidPlansOn = PAID_PLANS_ENABLED;
/** Tests only: switch paid plans on or off (PAID_PLANS_ENABLED otherwise). */
export function setPaidPlansEnabledForTests(on: boolean): void {
  paidPlansOn = on;
}

/** Grace after a failed subscription payment before the store drops to FREE (P.5). */
export const PLAN_PAYMENT_GRACE_DAYS = 7;
/** Grace after a FREE store reaches its order limit before new checkouts pause (P.7). */
export const FREE_ORDER_LIMIT_GRACE_DAYS = 7;
/** The merchant is warned at this share of the FREE order limit (P.7): 24 of 30. */
export const ORDER_LIMIT_WARNING_RATIO = 0.8;
/** Draft stores one account may have at a time (P.3), against abuse. */
export const MAX_DRAFT_STORES_PER_ACCOUNT = 5;

export function isStorePlan(v: unknown): v is StorePlan {
  return typeof v === "string" && (STORE_PLANS as readonly string[]).includes(v);
}

/** The plan's definition; anything that isn't a known plan is FREE (never a paid plan by accident). */
export function getPlan(id: unknown): Readonly<PlanDefinition> {
  return PLANS[isStorePlan(id) ? id : "FREE"];
}

/** A paid plan needs a subscription (P.5); FREE doesn't. */
export function isPaidPlan(id: StorePlan): boolean {
  return CURRENCY_CODES.some((c) => PLANS[id].monthlyPriceMinor[c] > 0);
}

/**
 * The Stripe Price lookup key for a paid plan in a currency (`ceseelia_spark_cad`), or null for
 * FREE. Prices are created on the platform account and found by this key (P.5), never by an id
 * written in code.
 */
export function planPriceLookupKey(id: StorePlan, currency: CurrencyCode): string | null {
  return isPaidPlan(id) ? `ceseelia_${id.toLowerCase()}_${currency.toLowerCase()}` : null;
}

/** The reverse of planPriceLookupKey: `ceseelia_spark_cad` → { plan: "SPARK", currency: "CAD" }. */
export function planFromLookupKey(key: unknown): { plan: StorePlan; currency: CurrencyCode } | null {
  if (typeof key !== "string") return null;
  const m = /^ceseelia_([a-z]+)_([a-z]{3})$/.exec(key);
  if (!m) return null;
  const plan = m[1].toUpperCase();
  const currency = m[2].toUpperCase();
  if (!isStorePlan(plan) || !isPaidPlan(plan) || !(CURRENCY_CODES as readonly string[]).includes(currency)) return null;
  return { plan, currency: currency as CurrencyCode };
}

/** The order count at which a plan's merchant is warned (P.7), or null without a limit. */
export function orderLimitWarningAt(id: StorePlan): number | null {
  const limit = PLANS[id].monthlyOrderLimit;
  return limit === null ? null : Math.ceil(limit * ORDER_LIMIT_WARNING_RATIO);
}
