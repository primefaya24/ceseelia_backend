import { createHash } from "crypto";
import { StoreCategory, StoreInventoryData, StoreItem } from "../interfaces/store";
import { AiBatch, AiBatchItem, AiFinding, reviewBatch } from "./ai";
import { runRuleChecks, RuleHit } from "./rules";
import { chunk, pickImageItems } from "./select";

/*
 * The AI store check (progress.md P.4c / L.2, owner decisions 2026-11-14).
 *
 * Go Live calls runSmartStoreValidation before a store becomes LIVE; the background item check
 * (item-check.ts) calls checkCatalogue for items a live store added or changed. Either way:
 *   1. cheap rule checks (rules.ts): hints, plus hard flags such as a crypto wallet address;
 *   2. the AI (ai.ts) reads every item's text and photos of up to 50 items picked by risk
 *      (select.ts), in batches of 150 items run in parallel;
 *   3. any finding with evidence, or any hard flag, means a human looks. The AI never rejects.
 *
 * The caller (POST /store/go-live) acts on the result:
 *   ok: true  → checkout, then LIVE.
 *   ok: false → IN_REVIEW: the merchant sees "We're reviewing your store", `reasons` (one line
 *               per finding) go to the admin review queue (approve → LIVE, reject → DRAFT, P.8).
 * If this throws (no key, the API down, the 90 s deadline), the caller treats it as flagged
 * (fails closed), never as passed.
 */
export interface SmartStoreValidationInput {
  storeId: string;
  /** The store's full data as members see it (settings, categories, items, inactive included). */
  data: StoreInventoryData;
}

export interface StoreCheckFinding extends AiFinding {
  source: "AI" | "RULES";
}

export type SmartStoreValidationResult =
  | { ok: true; findings?: StoreCheckFinding[] }
  | {
      ok: false;
      /** Why the store needs a human look, for admins only (never shown to the merchant). */
      reasons: string[];
      findings?: StoreCheckFinding[];
    };

/* Go Live waits this long ("Checking your store…"), then the store goes to review (owner 2026-11-14). */
export const GO_LIVE_CHECK_DEADLINE_MS = 90_000;
/* AI requests at once for a big catalogue. */
const PARALLEL_BATCHES = 4;

export class StoreCheckTimeoutError extends Error {
  constructor() {
    super("The AI store check took too long");
    this.name = "StoreCheckTimeoutError";
  }
}

const major = (minor: number) => (Number.isFinite(minor) ? (minor / 100).toFixed(2) : "");

function batchItem(i: StoreItem, categoryName: string, withImage: boolean): AiBatchItem {
  return {
    id: i.storeItemId,
    name: i.storeItemName,
    description: i.storeItemDescription,
    category: categoryName,
    prices: Object.fromEntries(Object.entries(i.storeItemPrices ?? {}).map(([c, v]) => [c, major(v as number)])),
    options: (i.storeItemCustomParams ?? []).map((p) => `${p.storeParamLabel}: ${(p.storeParamOptions ?? []).join(", ")}`),
    ...(withImage && i.storeItemImageUris?.[0] ? { imageUri: i.storeItemImageUris[0] } : {}),
  };
}

async function inParallel<T, R>(list: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const k = next++;
      out[k] = await fn(list[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

export interface CatalogueCheckInput {
  storeName: string;
  slogan: string;
  logoUri?: string;
  categories: StoreCategory[];
  /** The items to check (a whole store at Go Live; the changed ones for a live store). */
  items: StoreItem[];
}

export interface CatalogueCheckResult {
  findings: StoreCheckFinding[];
  usage: { inputTokens: number; outputTokens: number; requests: number };
}

export async function checkCatalogue(
  input: CatalogueCheckInput,
  opts: { signal?: AbortSignal; rng?: () => number } = {}
): Promise<CatalogueCheckResult> {
  const rules = runRuleChecks({
    storeName: input.storeName,
    storeDescription: input.slogan,
    items: input.items,
  });
  const photos = pickImageItems(input.items, rules.hints, undefined, opts.rng);
  const categoryName = new Map(input.categories.map((c) => [c.storeCategoriyId, c.storeCategoryName]));
  const store = {
    name: input.storeName,
    slogan: input.slogan,
    categories: input.categories.map((c) => c.storeCategoryName),
  };

  const batches: AiBatch[] = chunk(input.items).map((items, k) => {
    const ids = new Set(items.map((i) => i.storeItemId));
    return {
      store: { ...store, ...(k === 0 && input.logoUri ? { logoUri: input.logoUri } : {}) },
      items: items.map((i) => batchItem(i, categoryName.get(i.storeItemCategoryId) ?? "", photos.has(i.storeItemId))),
      hints: rules.hints.filter((h: RuleHit) => (h.itemId ? ids.has(h.itemId) : k === 0)),
    };
  });

  const results = await inParallel(batches, PARALLEL_BATCHES, (b) => reviewBatch(b, opts.signal));
  const findings: StoreCheckFinding[] = [
    ...rules.hardFlags.map((h) => ({ ...h, explanation: "Found by the automatic rules.", source: "RULES" as const })),
    ...results.flatMap((r) => r.findings.map((f) => ({ ...f, source: "AI" as const }))),
  ];
  return {
    findings,
    usage: {
      inputTokens: results.reduce((n, r) => n + r.usage.inputTokens, 0),
      outputTokens: results.reduce((n, r) => n + r.usage.outputTokens, 0),
      requests: results.length,
    },
  };
}

/* One line per finding for the admin review queue. */
export function formatFinding(f: StoreCheckFinding, itemNames: Map<string, string>): string {
  const where = f.itemId ? `Item "${itemNames.get(f.itemId) ?? f.itemId}" (${f.itemId})` : "Store";
  return `[${f.code}] ${where}: ${f.evidence}${f.explanation ? ` (${f.explanation})` : ""}`;
}

/* Runs `fn` with an abort signal that fires after `ms`; a timeout throws StoreCheckTimeoutError. */
export async function withDeadline<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new StoreCheckTimeoutError());
    }, ms);
  });
  try {
    return await Promise.race([fn(ctl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runSmartStoreValidation(
  input: SmartStoreValidationInput,
  opts: { deadlineMs?: number; rng?: () => number } = {}
): Promise<SmartStoreValidationResult> {
  const { settings, categories, items } = input.data;
  const result = await withDeadline(opts.deadlineMs ?? GO_LIVE_CHECK_DEADLINE_MS, (signal) =>
    checkCatalogue(
      {
        storeName: settings.storeInfo?.storeName ?? "",
        slogan: settings.storeInfo?.slogan ?? "",
        logoUri: settings.storeInfo?.logoUri || undefined,
        categories,
        items,
      },
      { signal, rng: opts.rng }
    )
  );
  console.warn(
    `[store check] store ${input.storeId}: ${items.length} items, ${result.findings.length} finding(s), ` +
      `${result.usage.requests} request(s), ${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens`
  );
  if (result.findings.length === 0) return { ok: true, findings: [] };
  const names = new Map(items.map((i) => [i.storeItemId, i.storeItemName]));
  return { ok: false, reasons: result.findings.map((f) => formatFinding(f, names)), findings: result.findings };
}

/*
 * What the item check looks at, as a fingerprint: a save that changes only stock (or nothing the
 * check reads) isn't checked again.
 */
export function itemCheckFingerprint(i: StoreItem): string {
  const seen = {
    name: i.storeItemName,
    description: i.storeItemDescription,
    category: i.storeItemCategoryId,
    images: i.storeItemImageUris,
    prices: i.storeItemPrices,
    params: (i.storeItemCustomParams ?? []).map((p) => [p.storeParamLabel, p.storeParamOptions]),
    variantPrices: (i.storeItemVariants ?? []).map((v) => v.storeVariantPrices),
  };
  return createHash("sha256").update(JSON.stringify(seen)).digest("hex").slice(0, 32);
}
