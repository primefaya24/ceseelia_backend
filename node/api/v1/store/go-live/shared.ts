import { PLANS, STORE_PLANS, isPlanAvailable, StorePlan } from "../../../../layers/core/plans";

/** A plan as the Go Live sheet shows it: what it costs in the store's billing currency (A1). */
export interface GoLivePlanOption {
  id: StorePlan;
  name: string;
  /** null until Stripe is connected (the billing currency comes from its country). */
  monthlyPriceMinor: number | null;
  commissionMinor: number | null;
  customDomain: boolean;
  /** Can be chosen now (plans need PAID_PLANS_ENABLED, P.5, unless an admin gave it). */
  available: boolean;
  /** Why not, when it can't be: PLAN_NOT_AVAILABLE (plans switched off). */
  unavailableReason: "PLAN_NOT_AVAILABLE" | null;
}

export function planOptions(
  currency: "CAD" | "USD" | "AUD" | null,
  /** A plan an admin gave the store (P.8): always available, nothing to pay. */
  gifted: StorePlan | null = null
): GoLivePlanOption[] {
  return STORE_PLANS.map((id) => {
    const p = PLANS[id];
    const reason = id === gifted || isPlanAvailable(id) ? null : "PLAN_NOT_AVAILABLE";
    return {
      id,
      name: p.name,
      monthlyPriceMinor: currency ? p.monthlyPriceMinor[currency] : null,
      commissionMinor: currency ? p.commissionMinor[currency] : null,
      customDomain: p.customDomain,
      available: reason === null,
      unavailableReason: reason,
    };
  });
}
