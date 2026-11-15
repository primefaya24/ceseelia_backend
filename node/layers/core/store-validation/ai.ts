import Anthropic from "@anthropic-ai/sdk";
import { getStorageImageUrl } from "../utils";
import { readAppSecretString } from "../../aws/secret-manager/app-secrets";
import { FINDING_CODES, FindingCode, STORE_CHECK_SYSTEM_PROMPT } from "./policy";
import { RuleHit } from "./rules";

/*
 * The Claude API side of the AI store check (L.2). One request per batch of items (see
 * select.ts); the store's name, slogan and categories go with every batch. The answer is
 * constrained to a JSON schema (structured outputs), and a refused request is retried on another
 * model server-side (`fallbacks: "default"`); if that refuses too, the batch counts as a finding
 * so a human looks (never as a pass).
 */
export const STORE_CHECK_MODEL = "claude-opus-5-5";
/* Thinking depth. Tune with the eval set (scripts/store-check-eval): higher is slower. */
export const STORE_CHECK_EFFORT = "medium" as const;

export class AiCheckNotConfiguredError extends Error {
  constructor() {
    super("The AI store check has no API key (anthropicApiKey in the app secret)");
    this.name = "AiCheckNotConfiguredError";
  }
}

export interface AiFinding {
  itemId: string | null;
  code: FindingCode;
  evidence: string;
  explanation: string;
}

export interface AiBatchItem {
  id: string;
  name: string;
  description: string;
  category: string;
  /** Major units per currency, e.g. { CAD: "89.00" }. */
  prices: Record<string, string>;
  options: string[];
  /** Storage key of the photo the AI sees, if this item was picked for one. */
  imageUri?: string;
}

export interface AiBatch {
  store: { name: string; slogan: string; categories: string[]; logoUri?: string };
  items: AiBatchItem[];
  hints: RuleHit[];
}

export interface AiBatchResult {
  findings: AiFinding[];
  usage: { inputTokens: number; outputTokens: number };
}

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "REVIEW"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["itemId", "code", "evidence", "explanation"],
        properties: {
          itemId: { anyOf: [{ type: "string" }, { type: "null" }] },
          code: { type: "string", enum: [...FINDING_CODES] },
          evidence: { type: "string" },
          explanation: { type: "string" },
        },
      },
    },
  },
} as const;

let clientPromise: Promise<Anthropic> | null = null;

async function getClient(): Promise<Anthropic> {
  if (!clientPromise) {
    clientPromise = readAppSecretString()
      .then((raw) => {
        let apiKey = "";
        try {
          const v = (JSON.parse(raw ?? "{}") as Record<string, unknown>).anthropicApiKey;
          apiKey = typeof v === "string" ? v.trim() : "";
        } catch {
          // not JSON: treated as no key
        }
        if (!apiKey) throw new AiCheckNotConfiguredError();
        return new Anthropic({ apiKey, maxRetries: 1 });
      })
      .catch((e) => {
        clientPromise = null;
        throw e;
      });
  }
  return clientPromise;
}

/* Tests only. */
export function resetAiClientForTests(client?: Anthropic): void {
  clientPromise = client ? Promise.resolve(client) : null;
}

function catalogueText(b: AiBatch): string {
  const store = { name: b.store.name, slogan: b.store.slogan, categories: b.store.categories };
  const items = b.items.map(({ imageUri: _img, ...rest }) => rest);
  const hints = b.hints.length
    ? b.hints.map((h) => `- ${h.code} (${h.itemId ? `item ${h.itemId}` : "store"}): "${h.evidence}"`).join("\n")
    : "none";
  return [
    "Review this store's catalogue.",
    "<store>",
    JSON.stringify({ store, items }, null, 1),
    "</store>",
    `Automatic hints:\n${hints}`,
    "Photos of some items follow, each labelled with its item id.",
  ].join("\n");
}

function content(b: AiBatch, withImages: boolean): Anthropic.Beta.Messages.BetaContentBlockParam[] {
  const blocks: Anthropic.Beta.Messages.BetaContentBlockParam[] = [{ type: "text", text: catalogueText(b) }];
  if (!withImages) return blocks;
  if (b.store.logoUri) {
    blocks.push({ type: "text", text: "Store logo:" });
    blocks.push({ type: "image", source: { type: "url", url: getStorageImageUrl(b.store.logoUri) } });
  }
  for (const i of b.items) {
    if (!i.imageUri) continue;
    blocks.push({ type: "text", text: `Photo of item ${i.id}:` });
    blocks.push({ type: "image", source: { type: "url", url: getStorageImageUrl(i.imageUri) } });
  }
  return blocks;
}

/* Keeps only well-formed findings about this batch's items (or the store). */
export function parseFindings(text: string, itemIds: Set<string>): AiFinding[] {
  const data = JSON.parse(text) as { findings?: unknown };
  if (!Array.isArray(data.findings)) throw new Error("AI answer has no findings array");
  const codes = new Set<string>(FINDING_CODES);
  return data.findings.flatMap((f): AiFinding[] => {
    const x = f as Record<string, unknown>;
    const itemId = typeof x.itemId === "string" && itemIds.has(x.itemId) ? x.itemId : null;
    const code = typeof x.code === "string" && codes.has(x.code) ? (x.code as FindingCode) : null;
    const evidence = typeof x.evidence === "string" ? x.evidence.trim() : "";
    const explanation = typeof x.explanation === "string" ? x.explanation.trim() : "";
    // A finding without evidence doesn't meet the bar (policy.ts): it's dropped, not flagged.
    if (!code || !evidence) return [];
    return [{ itemId, code, evidence: evidence.slice(0, 500), explanation: explanation.slice(0, 500) }];
  });
}

async function ask(client: Anthropic, b: AiBatch, withImages: boolean, signal?: AbortSignal) {
  return client.beta.messages.create(
    {
      model: STORE_CHECK_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: STORE_CHECK_EFFORT, format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      system: [{ type: "text", text: STORE_CHECK_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: content(b, withImages) }],
    },
    { signal }
  );
}

export async function reviewBatch(b: AiBatch, signal?: AbortSignal): Promise<AiBatchResult> {
  const client = await getClient();
  const withImages = b.items.some((i) => i.imageUri) || !!b.store.logoUri;
  let res;
  try {
    res = await ask(client, b, withImages, signal);
  } catch (e) {
    // An image the API couldn't fetch (deleted, bad URL) fails the whole request: check the
    // text without photos rather than not at all.
    if (withImages && e instanceof Anthropic.BadRequestError) {
      console.warn(`[store check] images rejected (${e.message}); checking text only`);
      res = await ask(client, b, false, signal);
    } else {
      throw e;
    }
  }
  const usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };

  if (res.stop_reason === "refusal") {
    const category = res.stop_details?.category ?? "unspecified";
    return {
      findings: [
        {
          itemId: null,
          code: "OTHER",
          evidence: `The AI declined to review this catalogue (safety category: ${category}).`,
          explanation: "Content the AI won't process usually needs a human look.",
        },
      ],
      usage,
    };
  }
  if (res.stop_reason === "max_tokens") throw new Error("AI answer was cut off (max_tokens)");

  const text = res.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
  return { findings: parseFindings(text, new Set(b.items.map((i) => i.id))), usage };
}
