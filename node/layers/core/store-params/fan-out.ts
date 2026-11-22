import { isStoreItemValid, StoreItem } from "../interfaces/store";
import { MAX_VARIANTS, combinationCount } from "../variants";
import {
  getStoreItem,
  listStoreItems,
  updateItemParamsIfUnchanged,
} from "../../aws/dynamodb/dynamo-entities/store";
import { queueItemCheck } from "../../aws/dynamodb/dynamo-entities/item-review";
import { ITEM_CHECK_DELAY_MS } from "../store-validation/item-check";
import { log } from "../logger";
import { itemParamsChanged, itemUsesParam } from "./index";

/*
 * Stage R: carry a parameter save or delete to every item that uses it (R.3b / R.3c).
 *
 *   1. `planItemChanges` works out every affected item's new shape and checks each one with the
 *      same validator an item save uses. If any would break (over 100 combinations, nothing left
 *      for sale, its name already on the item…), nothing is written and the route answers 409
 *      with those items, so the merchant can fix them first.
 *   2. `writeItemChanges` writes each changed item only if it is still as read (a paid order or a
 *      merchant save meanwhile → re-read, re-apply, retry). Safe to run again: applying the same
 *      parameter twice changes nothing. Live stores' items get an AI check queued, exactly like
 *      an item save (the text they show changed).
 */

export type ItemProblem = "TOO_MANY_COMBINATIONS" | "NAME_ON_ITEM" | "NOTHING_FOR_SALE" | "INVALID";

export interface ItemChangePlan {
  changes: { before: StoreItem; after: StoreItem }[];
  problems: { itemId: string; itemName: string; problem: ItemProblem }[];
}

function problemOf(after: StoreItem): ItemProblem {
  const params = after.storeItemCustomParams ?? [];
  if (combinationCount(params) > MAX_VARIANTS) return "TOO_MANY_COMBINATIONS";
  const labels = params.map((p) => p.storeParamLabel.trim().toLowerCase());
  if (new Set(labels).size !== labels.length) return "NAME_ON_ITEM";
  const rows = after.storeItemVariants ?? [];
  if (rows.length > 0 && !rows.some((r) => r.storeVariantIsActive)) return "NOTHING_FOR_SALE";
  return "INVALID";
}

/** The new shape of every item using `paramId`, or the items it would break. */
export function planItemChanges(
  storeId: string,
  items: StoreItem[],
  paramId: string,
  change: (item: StoreItem) => StoreItem
): ItemChangePlan {
  const plan: ItemChangePlan = { changes: [], problems: [] };
  for (const before of items) {
    if (!itemUsesParam(before, paramId)) continue;
    const after = change(before);
    if (!isStoreItemValid(after, storeId, before.storeItemId)) {
      plan.problems.push({ itemId: before.storeItemId, itemName: before.storeItemName, problem: problemOf(after) });
    } else if (itemParamsChanged(before, after)) {
      plan.changes.push({ before, after });
    }
  }
  return plan;
}

/** `planItemChanges` over the store's items as they are now. */
export async function planForStore(
  storeId: string,
  paramId: string,
  change: (item: StoreItem) => StoreItem
): Promise<ItemChangePlan> {
  return planItemChanges(storeId, await listStoreItems(storeId), paramId, change);
}

const WRITE_ATTEMPTS = 4;
const PARALLEL = 8;

/** Writes the planned items. Returns how many were written and how many couldn't be. */
export async function writeItemChanges(
  storeId: string,
  plan: ItemChangePlan,
  paramId: string,
  change: (item: StoreItem) => StoreItem
): Promise<{ updated: number; failed: number }> {
  let updated = 0;
  let failed = 0;
  const one = async ({ before, after }: { before: StoreItem; after: StoreItem }) => {
    let b: StoreItem | null = before;
    let a = after;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      if (await updateItemParamsIfUnchanged(storeId, b, a)) {
        updated++;
        await queueItemCheck(storeId, b.storeItemId, ITEM_CHECK_DELAY_MS).catch((e) =>
          log.error({ err: e }, `[store params] couldn't queue item ${b?.storeItemId}`)
        );
        return;
      }
      // Changed under us: start again from what's stored.
      b = await getStoreItem(storeId, before.storeItemId);
      if (!b || !itemUsesParam(b, paramId)) return; // deleted, or no longer uses it
      a = change(b);
      if (!itemParamsChanged(b, a)) return;
      if (!isStoreItemValid(a, storeId, b.storeItemId)) break;
    }
    failed++;
    log.error({ storeId, itemId: before.storeItemId, paramId }, "[store params] item not updated");
  };
  for (let i = 0; i < plan.changes.length; i += PARALLEL) {
    await Promise.all(plan.changes.slice(i, i + PARALLEL).map(one));
  }
  return { updated, failed };
}

