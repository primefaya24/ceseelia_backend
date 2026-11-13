import { isUlid } from "../core/utils";
import {
  blocksNewSubscription,
  isPaying,
  lifecycleAfter,
  mayReplace,
  planEffect,
  subscriptionRecord,
} from "../core/billing";
import {
  BillingWriteConflictError,
  clearBillingCheckout,
  deleteGraceEntry,
  getStoreBillingState,
  listExpiredGrace,
  writeStoreBilling,
} from "../aws/dynamodb/dynamo-entities/billing";
import { findLiveFreeStoreAdministeredBy } from "../aws/dynamodb/dynamo-entities/membership";
import { cancelSubscriptionNow, retrieveSubscriptionSnapshot } from "./billing";

/*
 * Bring a store in line with its subscription (progress.md P.5). Always reads the subscription
 * from Stripe now, never from the event's copy, so events can arrive late, twice or out of
 * order and the result is the same: that's what makes the webhook idempotent. Writes are
 * conditional on what was read; on a conflict it reads again (3 tries).
 */
export type SyncOutcome =
  | "UPDATED"
  | "UNCHANGED"
  | "NOT_OURS"
  | "STORE_GONE"
  | "DUPLICATE_CANCELLED"
  | "IGNORED_OLDER";

export async function syncSubscription(subscriptionId: string, now: () => number = Date.now): Promise<SyncOutcome> {
  const snap = await retrieveSubscriptionSnapshot(subscriptionId);
  if (!snap) return "NOT_OURS";
  const storeId = snap.metadata.storeId;
  const payerUserId = snap.metadata.userId;
  if (!storeId || !isUlid(storeId) || !payerUserId) return "NOT_OURS";

  for (let attempt = 0; ; attempt++) {
    const t = now();
    const state = await getStoreBillingState(storeId);
    if (!state) {
      // The store was deleted: nobody should keep paying for it.
      if (isPaying(snap.status) || snap.status === "unpaid") await cancelSubscriptionNow(snap.id);
      return "STORE_GONE";
    }

    if (!mayReplace(state.subscription, snap, t)) {
      if (isPaying(snap.status) && state.subscription && blocksNewSubscription(state.subscription, t)) {
        // A second subscription for a store that already has one (two checkouts paid at once).
        console.error(`[billing] store ${storeId}: cancelling duplicate subscription ${snap.id}`);
        await cancelSubscriptionNow(snap.id);
        return "DUPLICATE_CANCELLED";
      }
      return "IGNORED_OLDER";
    }

    const sameSub = state.subscription?.subscriptionId === snap.id;
    const effect = planEffect(snap, sameSub ? (state.subscription?.graceEndsAt ?? null) : null, t);
    const otherLiveFreeStore =
      effect.kind === "FREE" && state.lifecycle.status === "LIVE" && state.lifecycle.plan !== "FREE"
        ? (await findLiveFreeStoreAdministeredBy(payerUserId, storeId)) !== null
        : false;
    const lifecycle = lifecycleAfter(state.lifecycle, effect, { now: t, otherLiveFreeStore });
    const record = subscriptionRecord(snap, payerUserId, effect, t);
    const lifecycleChanged = lifecycle !== state.lifecycle;
    const unchanged =
      !lifecycleChanged &&
      sameSub &&
      JSON.stringify({ ...state.subscription, syncedAt: 0 }) === JSON.stringify({ ...record, syncedAt: 0 });
    // The checkout is done once its subscription exists (paid or not).
    const clearCheckout = !!state.checkout && effect.kind !== "NONE";
    if (unchanged && !clearCheckout) return "UNCHANGED";

    try {
      await writeStoreBilling(state, {
        subscription: record,
        lifecycle: lifecycleChanged ? lifecycle : null,
        clearCheckout,
        grace: effect.kind === "GRACE" ? "PUT" : sameSub && state.subscription?.graceEndsAt ? "DELETE" : null,
      });
      return "UPDATED";
    } catch (e) {
      if (e instanceof BillingWriteConflictError && attempt < 2) continue;
      throw e;
    }
  }
}

/* checkout.session.expired: forget it, so the next Go Live makes a new one. */
export async function forgetExpiredCheckout(storeId: string | undefined, sessionId: string): Promise<void> {
  if (storeId && isUlid(storeId)) await clearBillingCheckout(storeId, sessionId);
}

/*
 * The hourly sweep (index.ts): stores whose grace has ended are synced again, which drops them
 * to FREE unless the merchant paid meanwhile. A store without a subscription anymore leaves
 * the list.
 */
export async function sweepExpiredGrace(now: () => number = Date.now): Promise<number> {
  const due = await listExpiredGrace(now());
  let done = 0;
  for (const storeId of due) {
    try {
      const state = await getStoreBillingState(storeId);
      if (!state?.subscription) {
        await deleteGraceEntry(storeId);
        continue;
      }
      await syncSubscription(state.subscription.subscriptionId, now);
      const after = await getStoreBillingState(storeId);
      if (!after?.subscription?.graceEndsAt || after.subscription.graceEndsAt <= now()) await deleteGraceEntry(storeId);
      done++;
    } catch (e) {
      console.error(`[billing] grace sweep failed for store ${storeId}`, e);
    }
  }
  return done;
}
