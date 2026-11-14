import { NO_PLAN, StorePlanOrNone, toStorePlanOrNone } from "../plans";
import { StoreLifecycle, StoreReview } from "../interfaces/store";

/*
 * Review decisions (progress.md P.8), with no I/O. Every plan is paid (no Free plan, 2026-11-13),
 * so an admin's yes never takes a store live by itself, and never takes a card for the merchant:
 *   APPROVE → DRAFT and approved: their next Go Live skips the check and goes straight to
 *     checkout (or straight live on a plan an admin gave)
 *   REJECT → DRAFT with the admin's message for the merchant (they can fix it and try again)
 */
export const REVIEW_DECISIONS = ["APPROVE", "REJECT"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
export const REVIEW_MESSAGE_MAX = 500;

/** The plan the merchant asked for when the store went to review (NONE: unknown, e.g. the old FREE). */
export function requestedPlanOf(review: StoreReview | undefined): StorePlanOrNone {
  return toStorePlanOrNone(review?.requestedPlan);
}

export function lifecycleAfterReview(
  lifecycle: StoreLifecycle,
  decision: ReviewDecision,
  opts: { now: number; message?: string }
): StoreLifecycle {
  const { reviewRejection: _r, reviewApprovedAt: _a, pausedReason: _p, ...base } = lifecycle;
  const draft = { ...base, status: "DRAFT" as const, statusChangedAt: opts.now };
  if (decision === "REJECT") {
    return { ...draft, reviewRejection: { message: (opts.message ?? "").trim(), at: opts.now } };
  }
  return { ...draft, reviewApprovedAt: opts.now };
}

/*
 * A plan set by an admin (P.8): marked, so billing knows and the merchant sees it's a gift.
 * NONE takes the plan away: a live store goes back to a DRAFT (no plan, not live).
 */
export function lifecycleWithAdminPlan(
  lifecycle: StoreLifecycle,
  plan: StorePlanOrNone,
  now = Date.now()
): StoreLifecycle {
  const { planSetByAdmin: _s, ...rest } = lifecycle;
  if (plan !== NO_PLAN) return { ...rest, plan, planSetByAdmin: true };
  if (rest.status === "LIVE")
    return { ...rest, plan, status: "DRAFT", statusChangedAt: now, pausedReason: "PLAN_ENDED" };
  return { ...rest, plan };
}
