import { PLAN_PAYMENT_GRACE_DAYS, StorePlan } from "../plans";
import { StoreLifecycle, StoreSubscription } from "../interfaces/store";

/*
 * Subscription rules (progress.md P.5), with no I/O so every case is unit-tested. The sync
 * (layers/payments/subscription-sync) reads the subscription from Stripe, asks these what it
 * means for the store, and writes the answer.
 *
 *   active / trialing / past_due → the paid plan (past_due = Stripe is still retrying)
 *   unpaid, or canceled because payment failed, or paused → 7 days' grace on the paid plan,
 *     then FREE
 *   canceled for any other reason (the merchant cancelled; Stripe ends it at the period's end)
 *     → FREE now
 *   incomplete / incomplete_expired → never started: nothing changes
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const PLAN_PAYMENT_GRACE_MS = PLAN_PAYMENT_GRACE_DAYS * DAY_MS;

/** What the sync needs from a Stripe subscription. */
export interface SubscriptionSnapshot {
  id: string;
  customerId: string;
  status: string;
  /** From the price's lookup key; null when the price isn't one of ours. */
  plan: StorePlan | null;
  currency: string;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** cancellation_details.reason, e.g. "payment_failed" or "cancellation_requested". */
  cancellationReason: string | null;
  /** When it ended (ms), or null. */
  endedAt: number | null;
  metadata: { storeId?: string; userId?: string; plan?: string };
}

const PAYING = new Set(["active", "trialing", "past_due"]);
const NOT_STARTED = new Set(["incomplete", "incomplete_expired"]);

/** The subscription pays for the plan now (Stripe may still be retrying a payment). */
export function isPaying(status: string): boolean {
  return PAYING.has(status);
}

/** Payment failed for good: grace, then FREE. */
export function isPaymentLost(s: Pick<SubscriptionSnapshot, "status" | "cancellationReason">): boolean {
  return s.status === "unpaid" || s.status === "paused" || (s.status === "canceled" && s.cancellationReason === "payment_failed");
}

/** It still holds a plan, or will soon: a second subscription for the store must not start. */
export function blocksNewSubscription(sub: StoreSubscription | undefined, now: number): boolean {
  if (!sub) return false;
  if (isPaying(sub.status)) return true;
  return sub.graceEndsAt !== null && now < sub.graceEndsAt;
}

export type PlanEffect =
  | { kind: "PAID"; plan: StorePlan }
  | { kind: "GRACE"; plan: StorePlan; until: number }
  | { kind: "FREE" }
  | { kind: "NONE" };

/*
 * What the subscription means for the store now. `previousGraceEndsAt` keeps the grace's end
 * fixed once it started (a later event never moves it).
 */
export function planEffect(snap: SubscriptionSnapshot, previousGraceEndsAt: number | null, now: number): PlanEffect {
  if (NOT_STARTED.has(snap.status)) return { kind: "NONE" };
  if (!snap.plan) return { kind: "NONE" }; // not one of our prices: never guess a plan
  if (isPaying(snap.status)) return { kind: "PAID", plan: snap.plan };
  if (isPaymentLost(snap)) {
    const until = previousGraceEndsAt ?? (snap.endedAt ?? now) + PLAN_PAYMENT_GRACE_MS;
    return now < until ? { kind: "GRACE", plan: snap.plan, until } : { kind: "FREE" };
  }
  if (snap.status === "canceled") return { kind: "FREE" };
  return { kind: "NONE" };
}

/*
 * The store's lifecycle after the effect. `otherLiveFreeStore` = the payer already has another
 * live FREE store: a store dropping to FREE then goes back to DRAFT instead (one free store per
 * account), and says why. Returns the same object when nothing changes.
 */
export function lifecycleAfter(
  lifecycle: StoreLifecycle,
  effect: PlanEffect,
  opts: { now: number; otherLiveFreeStore: boolean }
): StoreLifecycle {
  const { now } = opts;
  if (effect.kind === "NONE") return lifecycle;
  if (effect.kind === "PAID" || effect.kind === "GRACE") {
    if (lifecycle.status === "DRAFT" && effect.kind === "PAID") {
      // Our checkout runs the checklist and runSmartStoreValidation before it takes a card, so a
      // paid draft goes live here.
      const { pausedReason: _p, ...rest } = lifecycle;
      return {
        ...rest,
        status: "LIVE",
        plan: effect.plan,
        statusChangedAt: now,
        firstLiveAt: lifecycle.firstLiveAt ?? now,
      };
    }
    return lifecycle.plan === effect.plan ? lifecycle : { ...lifecycle, plan: effect.plan };
  }
  // FREE
  if (lifecycle.plan === "FREE") return lifecycle;
  if (lifecycle.status === "LIVE" && opts.otherLiveFreeStore) {
    return { ...lifecycle, status: "DRAFT", plan: "FREE", statusChangedAt: now, pausedReason: "FREE_PLAN_IN_USE" };
  }
  return { ...lifecycle, plan: "FREE" };
}

/*
 * Whether this subscription may update the store, when the store already records `current`.
 * A different subscription only takes over when the recorded one no longer holds a plan; an old
 * one's late events never undo a newer one.
 */
export function mayReplace(current: StoreSubscription | undefined, snap: SubscriptionSnapshot, now: number): boolean {
  if (!current || current.subscriptionId === snap.id) return true;
  return !blocksNewSubscription(current, now) && !NOT_STARTED.has(snap.status);
}

/** The record saved on the store. */
export function subscriptionRecord(
  snap: SubscriptionSnapshot,
  payerUserId: string,
  effect: PlanEffect,
  now: number
): StoreSubscription {
  return {
    subscriptionId: snap.id,
    customerId: snap.customerId,
    payerUserId,
    plan: snap.plan ?? "FREE",
    currency: snap.currency,
    status: snap.status,
    currentPeriodEnd: snap.currentPeriodEnd,
    cancelAtPeriodEnd: snap.cancelAtPeriodEnd,
    graceEndsAt: effect.kind === "GRACE" ? effect.until : null,
    syncedAt: now,
  };
}
