import { StoreInventoryData } from "../interfaces/store";

/*
 * Smart store validation (progress.md P.4c, owner 2026-11-12).
 *
 * Runs on every Go Live, before a store becomes LIVE. Its purpose is to stop fraud on
 * Ceseelia: use AI to go through the store's items (names, descriptions, images, prices),
 * its name and its details, and make sure nothing sketchy is going on (scams, counterfeit or
 * prohibited goods, impersonation, too-good-to-be-true prices, ...).
 *
 * The caller (POST /store/go-live) acts on the result:
 *   ok: true  → the store goes LIVE.
 *   ok: false → the store goes to IN_REVIEW: the merchant sees "We're reviewing your store", and
 *               `reasons` go to the admin review queue (approve → LIVE, reject → DRAFT, P.8).
 * If this throws, the caller treats it as flagged (fails closed), never as passed.
 */
export interface SmartStoreValidationInput {
  storeId: string;
  /** The store's full data as members see it (settings, categories, items, inactive included). */
  data: StoreInventoryData;
}

export type SmartStoreValidationResult =
  | { ok: true }
  | {
      ok: false;
      /** Why the store needs a human look, for admins only (never shown to the merchant). */
      reasons: string[];
    };

export async function runSmartStoreValidation(
  _input: SmartStoreValidationInput
): Promise<SmartStoreValidationResult> {
  // TODO(owner, 2026-11-12): build the AI fraud check described above. The body is left empty on
  // purpose for now, so every store passes. Tracked in progress.md P.4c.
  return { ok: true };
}
