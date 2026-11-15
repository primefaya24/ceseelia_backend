import { appConstants } from "../../../constants";
import { StoreSettings } from "../interfaces/store";

/*
 * Purchase rewards (progress.md L.7 / 7.3, 7.4), the rules in one place.
 *
 * The merchant's settings (`purchaseRewards`): `pointsPerDollarSpent` (points per whole unit of
 * the order's currency), and one reward: `redemptionPointAmount` points for
 * `redemptionPointAmountValue` off: money (POINTS_TO_MONEY, in whole units with cents allowed, of
 * the order's currency) or a percentage of the items (POINTS_TO_DISCOUNT).
 *   - Earning: on the items the shopper paid for (after item, category, store and rewards
 *     discounts; no delivery, no tax), rounded down; once per order when it's paid; a refund
 *     takes back the same share of the points (owner 2026-11-15: commission is also on the
 *     price after a rewards discount).
 *   - Spending: one reward per order, taken off the items before tax.
 * The two spellings of the method (7.3: the webapp used REWARDS_REDEMPTION_*) mean the same;
 * `normalizeRedemptionMethod` maps the old ones.
 */
export const MONEY = appConstants.STORE_REWARDS_REDEMPTION_METHOD_POINTS_TO_MONEY;
export const DISCOUNT = appConstants.STORE_REWARDS_REDEMPTION_METHOD_POINTS_TO_DISCOUNT;
const LEGACY: Record<string, string> = { REWARDS_REDEMPTION_DOLLAR: MONEY, REWARDS_REDEMPTION_DISCOUNT: DISCOUNT };

export function normalizeRedemptionMethod(method: unknown): string {
  const m = String(method ?? "");
  return LEGACY[m] ?? m;
}

export interface RewardsProgram {
  label: string;
  pointsPerUnit: number;
  cost: number;
  kind: "MONEY" | "PERCENT";
  /** MONEY: minor units off; PERCENT: percent off the items. */
  value: number;
}

/** The store's program, or null when it's off or not filled in enough to run. */
export function rewardsProgram(settings: Pick<StoreSettings, "purchaseRewards"> | undefined): RewardsProgram | null {
  const r = settings?.purchaseRewards;
  if (!r || r.isAvailable !== true) return null;
  const method = normalizeRedemptionMethod(r.redemptionMethod);
  const perUnit = Number(r.pointsPerDollarSpent);
  const cost = Number(r.redemptionPointAmount);
  const raw = Number(r.redemptionPointAmountValue);
  if (!(perUnit > 0) || !Number.isInteger(cost) || cost < 1 || !(raw > 0)) return null;
  if (method === DISCOUNT) {
    if (raw > 100) return null;
    return { label: (r.rewardsLabel || "points").trim(), pointsPerUnit: perUnit, cost, kind: "PERCENT", value: raw };
  }
  if (method !== MONEY) return null;
  return { label: (r.rewardsLabel || "points").trim(), pointsPerUnit: perUnit, cost, kind: "MONEY", value: Math.round(raw * 100) };
}

/** What the pricing function takes off for one reward. */
export type RewardsDiscount = { kind: "MONEY"; minor: number } | { kind: "PERCENT"; percent: number };

export const discountOf = (p: RewardsProgram): RewardsDiscount =>
  p.kind === "MONEY" ? { kind: "MONEY", minor: p.value } : { kind: "PERCENT", percent: p.value };

/** Points for `baseMinor` of items paid for, rounded down. */
export function pointsFor(baseMinor: number, pointsPerUnit: number): number {
  if (!(baseMinor > 0) || !(pointsPerUnit > 0)) return 0;
  // In thousandths so 1.5 points per dollar on $10.01 is exact (15.015 → 15).
  return Math.floor((Math.floor(baseMinor) * Math.round(pointsPerUnit * 1000)) / 100_000);
}

/** Split `amount` (at most the weights' sum) over `weights` in whole units, largest remainder first; the parts add up exactly. */
export function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((n, w) => n + Math.max(0, w), 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  // Never more than the weights add up to (a line can't go below 0).
  amount = Math.min(Math.floor(amount), total);
  const exact = weights.map((w) => (Math.max(0, w) * amount) / total);
  const parts = exact.map(Math.floor);
  let left = amount - parts.reduce((n, p) => n + p, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    if (parts[i] < Math.max(0, weights[i])) {
      parts[i]++;
      left--;
    }
  }
  return parts;
}

/** An email shown back to its owner on another device: "an***@example.com". */
export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "***";
  return `${user.slice(0, 2)}${"*".repeat(Math.max(1, Math.min(6, user.length - 2)))}@${domain}`;
}
