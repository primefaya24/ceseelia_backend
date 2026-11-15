import { getStoreInventoryData, StoreRecordNotFoundError } from "../../aws/dynamodb/dynamo-entities/store";
import {
  deleteItemCheck,
  ItemCheckRow,
  listDueItemChecks,
  removeItemReviewRow,
  saveItemCheckResult,
} from "../../aws/dynamodb/dynamo-entities/item-review";
import { normalizeStoreLifecycle, StoreItem, StoreItemReview } from "../interfaces/store";
import { notifyItemsFlagged } from "../../notifications/admin-alerts";
import { checkCatalogue, formatFinding, itemCheckFingerprint, StoreCheckFinding, withDeadline } from ".";
import { log } from "../logger";

/*
 * The AI check of a LIVE store's new and changed items (progress.md L.2, owner 2026-11-14).
 * create-item queues each saved item (`queueItemCheck`, due ITEM_CHECK_DELAY_MS after the last
 * save); this sweep, every ITEM_CHECK_SWEEP_INTERVAL (index.ts), checks what's due, per store:
 *
 *   store not LIVE (a draft, in review)   → nothing to do: Go Live checks every item
 *   item gone                              → off the lists
 *   nothing the check reads changed        → skipped (a stock-only save), by fingerprint
 *   findings                               → FLAGGED: hidden from shoppers, on the admin queue,
 *                                            the team emailed; the rest of the store keeps selling
 *   no findings, was FLAGGED               → shown again (the merchant fixed it)
 *   no findings, was REJECTED              → FLAGGED again for a human ("changed after rejection")
 *   no findings, APPROVED or never flagged → nothing changes
 *
 * If the check can't run (no key, the API down), the rows stay and are tried again next sweep;
 * the item stays visible meanwhile (it's a live store's ordinary edit, not a new store).
 */
export const ITEM_CHECK_DELAY_MS = 3 * 60_000;
const SWEEP_BATCH = 200;
const STORE_DEADLINE_MS = 5 * 60_000;

export interface ItemSweepResult {
  checked: number;
  flagged: number;
  cleared: number;
  skipped: number;
  failed: number;
}

const REJECTED_THEN_CHANGED =
  "Changed by the merchant after an admin rejected it; the AI check found nothing this time. Approve to show it again.";

function nextReview(prev: StoreItemReview | undefined, reasons: string[], now: number): StoreItemReview | null | undefined {
  if (reasons.length > 0) return { status: "FLAGGED", reasons, flaggedAt: now };
  if (prev?.status === "REJECTED") return { status: "FLAGGED", reasons: [REJECTED_THEN_CHANGED], flaggedAt: now };
  if (prev?.status === "FLAGGED") return null;
  return undefined;
}

async function sweepStore(storeId: string, rows: ItemCheckRow[], now: number, out: ItemSweepResult): Promise<void> {
  let data;
  try {
    data = await getStoreInventoryData(storeId);
  } catch (e) {
    if (!(e instanceof StoreRecordNotFoundError)) throw e;
    for (const r of rows) await deleteItemCheck(r);
    return;
  }
  if (normalizeStoreLifecycle(data.settings.lifecycle).status !== "LIVE") {
    for (const r of rows) await deleteItemCheck(r);
    out.skipped += rows.length;
    return;
  }

  const byId = new Map(data.items.map((i) => [i.storeItemId, i]));
  const toCheck: { row: ItemCheckRow; item: StoreItem; hash: string }[] = [];
  for (const row of rows) {
    const item = byId.get(row.itemId);
    if (!item) {
      await removeItemReviewRow(storeId, row.itemId);
      await deleteItemCheck(row);
      continue;
    }
    const hash = itemCheckFingerprint(item);
    if (hash === item.storeItemCheckedHash) {
      await deleteItemCheck(row);
      out.skipped++;
      continue;
    }
    toCheck.push({ row, item, hash });
  }
  if (toCheck.length === 0) return;

  let findings: StoreCheckFinding[];
  try {
    const result = await withDeadline(STORE_DEADLINE_MS, (signal) =>
      checkCatalogue(
        {
          storeName: data.settings.storeInfo?.storeName ?? "",
          slogan: data.settings.storeInfo?.slogan ?? "",
          categories: data.categories,
          items: toCheck.map((t) => t.item),
        },
        { signal }
      )
    );
    findings = result.findings;
  } catch (e) {
    out.failed += toCheck.length;
    log.error({ err: e }, `[item check] store ${storeId}: ${toCheck.length} item(s) not checked`);
    return;
  }

  const names = new Map(toCheck.map((t) => [t.item.storeItemId, t.item.storeItemName]));
  // A finding about the store as a whole (no item) applies to every item in this check.
  const storeWide = findings.filter((f) => !f.itemId).map((f) => formatFinding(f, names));
  const newlyFlagged: { name: string; reasons: string[] }[] = [];
  for (const { row, item, hash } of toCheck) {
    out.checked++;
    const reasons = [
      ...findings.filter((f) => f.itemId === item.storeItemId).map((f) => formatFinding(f, names)),
      ...storeWide,
    ];
    const review = nextReview(item.storeItemReview, reasons, now);
    const saved = await saveItemCheckResult({
      storeId,
      itemId: item.storeItemId,
      hash,
      review,
      queue: {
        storeName: data.settings.storeInfo?.storeName ?? "",
        itemName: item.storeItemName,
        imageUri: item.storeItemImageUris?.[0] ?? "",
      },
    });
    if (saved && review?.status === "FLAGGED") {
      out.flagged++;
      newlyFlagged.push({ name: item.storeItemName, reasons: review.reasons });
    } else if (saved && review === null) {
      out.cleared++;
    }
    await deleteItemCheck(row);
  }
  if (newlyFlagged.length) await notifyItemsFlagged(storeId, data.settings.storeInfo?.storeName ?? "", newlyFlagged);
}

export async function sweepItemChecks(now: () => number = Date.now): Promise<ItemSweepResult> {
  const out: ItemSweepResult = { checked: 0, flagged: 0, cleared: 0, skipped: 0, failed: 0 };
  const rows = await listDueItemChecks(now(), SWEEP_BATCH);
  const byStore = new Map<string, ItemCheckRow[]>();
  for (const r of rows) byStore.set(r.storeId, [...(byStore.get(r.storeId) ?? []), r]);
  for (const [storeId, storeRows] of byStore) {
    try {
      await sweepStore(storeId, storeRows, now(), out);
    } catch (e) {
      out.failed += storeRows.length;
      log.error({ err: e }, `[item check] store ${storeId} failed`);
    }
  }
  return out;
}
