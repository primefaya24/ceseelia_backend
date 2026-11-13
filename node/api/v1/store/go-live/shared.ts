import { PLANS, STORE_PLANS, isPlanAvailable, StorePlan } from "../../../../layers/core/plans";

/** A plan as the Go Live sheet shows it: what it costs in the store's billing currency (A1). */
export interface GoLivePlanOption {
  id: StorePlan;
  name: string;
  /** null until Stripe is connected (the billing currency comes from its country). */
  monthlyPriceMinor: number | null;
  commissionMinor: number | null;
  monthlyOrderLimit: number | null;
  customDomain: boolean;
  /** Can be chosen now (paid plans need PAID_PLANS_ENABLED, P.5). */
  available: boolean;
  /** Why not, when it can't be: PLAN_NOT_AVAILABLE (paid plans switched off), FREE_PLAN_IN_USE. */
  unavailableReason: "PLAN_NOT_AVAILABLE" | "FREE_PLAN_IN_USE" | null;
}

export function planOptions(
  currency: "CAD" | "USD" | "AUD" | null,
  freeInUse: boolean,
  /** A plan an admin gave the store (P.8): always available, nothing to pay. */
  gifted: StorePlan | null = null
): GoLivePlanOption[] {
  return STORE_PLANS.map((id) => {
    const p = PLANS[id];
    const reason =
      id === gifted ? null : !isPlanAvailable(id) ? "PLAN_NOT_AVAILABLE" : id === "FREE" && freeInUse ? "FREE_PLAN_IN_USE" : null;
    return {
      id,
      name: p.name,
      monthlyPriceMinor: currency ? p.monthlyPriceMinor[currency] : null,
      commissionMinor: currency ? p.commissionMinor[currency] : null,
      monthlyOrderLimit: p.monthlyOrderLimit,
      customDomain: p.customDomain,
      available: reason === null,
      unavailableReason: reason,
    };
  });
}
