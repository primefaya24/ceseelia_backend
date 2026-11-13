import { isPaidPlan, isStorePlan, StorePlan } from "../plans";
import { StoreLifecycle, StoreReview } from "../interfaces/store";

/*
 * Review decisions (progress.md P.8), with no I/O.
 *   APPROVE, Free asked for → LIVE on FREE; but if the merchant has meanwhile put another store
 *     live on FREE (one per account), DRAFT and approved instead, so they pick a paid plan
 *   APPROVE, Spark / Nova asked for → DRAFT and approved: their next Go Live skips the check
 *     and goes straight to checkout (an admin's yes never takes a card for them)
 *   REJECT → DRAFT with the admin's message for the merchant (they can fix it and try again)
 */
export const REVIEW_DECISIONS = ["APPROVE", "REJECT"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
export const REVIEW_MESSAGE_MAX = 500;

export function requestedPlanOf(review: StoreReview | undefined, lifecycle: StoreLifecycle): StorePlan {
  return review && isStorePlan(review.requestedPlan) ? review.requestedPlan : lifecycle.plan;
}

export function lifecycleAfterReview(
  lifecycle: StoreLifecycle,
  requestedPlan: StorePlan,
  decision: ReviewDecision,
  opts: { now: number; message?: string; otherLiveFreeStore: boolean }
): StoreLifecycle {
  const { reviewRejection: _r, reviewApprovedAt: _a, pausedReason: _p, ...base } = lifecycle;
  const draft = { ...base, status: "DRAFT" as const, statusChangedAt: opts.now };
  if (decision === "REJECT") {
    return { ...draft, reviewRejection: { message: (opts.message ?? "").trim(), at: opts.now } };
  }
  if (isPaidPlan(requestedPlan) || opts.otherLiveFreeStore) return { ...draft, reviewApprovedAt: opts.now };
  return {
    ...base,
    status: "LIVE",
    plan: "FREE",
    statusChangedAt: opts.now,
    firstLiveAt: lifecycle.firstLiveAt ?? opts.now,
  };
}

/* A plan set by an admin (P.8): marked, so billing knows and the merchant sees it's a gift. */
export function lifecycleWithAdminPlan(lifecycle: StoreLifecycle, plan: StorePlan): StoreLifecycle {
  const { planSetByAdmin: _s, ...rest } = lifecycle;
  return plan === "FREE" ? { ...rest, plan } : { ...rest, plan, planSetByAdmin: true };
}
