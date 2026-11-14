import { CURRENCY_CODES } from "../../../constants/input-limits";
import { PAID_PLANS_ENABLED } from "../../../config";

/*
 * Store plans (progress.md P.1; Free dropped by the owner 2026-11-13). Plans are per store and
 * every plan is paid: a store has no plan ("NONE") until it subscribes, and only a store with a
 * plan is live. Going live and subscribing are one step (Go Live → Stripe Checkout); when the
 * plan ends the store goes back to a draft. This file is the only place plan prices and
 * commissions are written down: routes and the fee (P.6) read them from here, and the webapp
 * gets them from the API, never from its own copy.
 *
 * Amounts are whole cents per currency. A subscription is billed in the currency of the store's
 * Stripe account country (assumption A1 in progress.md §6a).
 */

export const STORE_PLANS = ["SPARK", "NOVA"] as const;
export type StorePlan = (typeof STORE_PLANS)[number];
/** A store that has no plan: a draft, never live (also what a store saved on the old FREE plan reads as). */
export const NO_PLAN = "NONE" as const;
export type StorePlanOrNone = StorePlan | typeof NO_PLAN;

type CurrencyCode = (typeof CURRENCY_CODES)[number];
export type PerCurrency = Record<CurrencyCode, number>;

export interface PlanDefinition {
  id: StorePlan;
  name: string;
  /** Monthly subscription price, cents per currency. */
  monthlyPriceMinor: PerCurrency;
  /** Default platform commission per order, cents per currency (FIXED; an admin can override, P.6). */
  commissionMinor: PerCurrency;
  /** Custom domains are offered on this plan ("coming soon" until 9.8). */
  customDomain: boolean;
}

export const PLANS: Readonly<Record<StorePlan, Readonly<PlanDefinition>>> = Object.freeze({
  SPARK: Object.freeze({
    id: "SPARK",
    name: "Spark",
    monthlyPriceMinor: Object.freeze({ CAD: 2500, AUD: 2500, USD: 1900 }),
    commissionMinor: Object.freeze({ CAD: 195, AUD: 195, USD: 145 }),
    customDomain: true,
  }),
  NOVA: Object.freeze({
    id: "NOVA",
    name: "Nova",
    monthlyPriceMinor: Object.freeze({ CAD: 4900, AUD: 4900, USD: 3900 }),
    commissionMinor: Object.freeze({ CAD: 0, AUD: 0, USD: 0 }),
    customDomain: true,
  }),
});

/**
 * Whether plans can be subscribed to today. They need Stripe Billing set up (P.5), switched on
 * with PAID_PLANS_ENABLED; while it's off they're listed but refused with PLAN_NOT_AVAILABLE
 * (only a plan an admin gave can go live), and the webapp marks them "coming soon".
 */
export function isPlanAvailable(_id: StorePlan): boolean {
  return paidPlansOn;
}

let paidPlansOn = PAID_PLANS_ENABLED;
/** Tests only: switch paid plans on or off (PAID_PLANS_ENABLED otherwise). */
export function setPaidPlansEnabledForTests(on: boolean): void {
  paidPlansOn = on;
}

/** Grace after a failed subscription payment before the plan ends and the store goes back to a draft (P.5). */
export const PLAN_PAYMENT_GRACE_DAYS = 7;

export function isStorePlan(v: unknown): v is StorePlan {
  return typeof v === "string" && (STORE_PLANS as readonly string[]).includes(v);
}

/** A saved plan as the store has it: SPARK / NOVA, anything else (old FREE, unknown) is NONE. */
export function toStorePlanOrNone(v: unknown): StorePlanOrNone {
  return isStorePlan(v) ? v : NO_PLAN;
}

/** The Stripe Price lookup key for a plan in a currency (`ceseelia_spark_cad`). Prices are created
 * on the platform account and found by this key (P.5), never by an id written in code. */
export function planPriceLookupKey(id: StorePlan, currency: CurrencyCode): string {
  return `ceseelia_${id.toLowerCase()}_${currency.toLowerCase()}`;
}

/** The reverse of planPriceLookupKey: `ceseelia_spark_cad` → { plan: "SPARK", currency: "CAD" }. */
export function planFromLookupKey(key: unknown): { plan: StorePlan; currency: CurrencyCode } | null {
  if (typeof key !== "string") return null;
  const m = /^ceseelia_([a-z]+)_([a-z]{3})$/.exec(key);
  if (!m) return null;
  const plan = m[1].toUpperCase();
  const currency = m[2].toUpperCase();
  if (!isStorePlan(plan) || !(CURRENCY_CODES as readonly string[]).includes(currency)) return null;
  return { plan, currency: currency as CurrencyCode };
}
