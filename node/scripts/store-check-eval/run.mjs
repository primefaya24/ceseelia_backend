// The AI store check's test set (progress.md L.2): 60 made-up stores, 30 legitimate (many of them
// deliberately tricky: kitchen knives, wine glasses, genuine sneakers, phone cases "for iPhone")
// and 30 that must go to review (prohibited, restricted or scams). Text only: no photos.
//
//   npm run build
//   node scripts/store-check-eval/run.mjs              # all 60 stores
//   node scripts/store-check-eval/run.mjs --only Luxe  # stores whose name contains "Luxe"
//
// Uses the real Claude API with `anthropicApiKey` from the app secret (APP_SECRET_ID, default
// ceseelia/dev), so it costs money: roughly $0.01–0.03 per store at the current settings.
// Prints each mistake, a summary, and the token use. Nothing is written to the database.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { checkCatalogue } = require("../../dist/layers/core/store-validation/index.js");
const { STORE_CHECK_MODEL, STORE_CHECK_EFFORT } = require("../../dist/layers/core/store-validation/ai.js");

const stores = JSON.parse(readFileSync(new URL("./stores.json", import.meta.url), "utf8"));
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const list = only ? stores.filter((s) => s.name.includes(only)) : stores;
const PRICE_IN = 4 / 1e6; // Claude Opus 5.5, $ per input token
const PRICE_OUT = 20 / 1e6;

const ulid = (n) => `01JBZ0000000000000000${String(n).padStart(5, "0")}`;
const CAT = "01JBZ0000000000000000CAT00";

console.log(`${list.length} stores · ${STORE_CHECK_MODEL} · effort ${STORE_CHECK_EFFORT}\n`);
const rows = [];
let tokensIn = 0;
let tokensOut = 0;
for (const [k, s] of list.entries()) {
  const items = s.items.map(([name, description, cents], j) => ({
    storeItemId: ulid(k * 10 + j),
    storeItemCategoryId: CAT,
    storeItemImageUris: [],
    storeItemName: name,
    storeItemDescription: description,
    storeItemPrices: { CAD: cents },
    storeItemStock: -1,
    storeItemIsActive: true,
    storeItemHashtagIds: [],
    storeItemDiscountPercent: 0,
    storeItemCustomParams: [],
  }));
  const started = Date.now();
  let got;
  let findings = [];
  try {
    const r = await checkCatalogue({
      storeName: s.name,
      slogan: "",
      categories: [{ storeCategoriyId: CAT, storeCategoryName: "Products" }],
      items,
    });
    findings = r.findings;
    tokensIn += r.usage.inputTokens;
    tokensOut += r.usage.outputTokens;
    got = findings.length ? "REVIEW" : "PASS";
  } catch (e) {
    got = `ERROR (${e.message})`;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = got === s.expect;
  rows.push({ ...s, got, ok, seconds });
  process.stdout.write(`${ok ? "✓" : "✗"} ${s.name.padEnd(28)} expected ${s.expect.padEnd(6)} got ${got.padEnd(6)} ${seconds}s\n`);
  if (!ok) {
    console.log(`    (${s.why})`);
    for (const f of findings) console.log(`    - [${f.code}] ${f.evidence} ${f.explanation ? `(${f.explanation})` : ""}`);
  }
}

const legit = rows.filter((r) => r.expect === "PASS");
const bad = rows.filter((r) => r.expect === "REVIEW");
const falseFlags = legit.filter((r) => r.got === "REVIEW").length;
const missed = bad.filter((r) => r.got === "PASS").length;
const errors = rows.filter((r) => r.got.startsWith("ERROR")).length;
const slowest = Math.max(...rows.map((r) => Number(r.seconds)));
console.log(`
Legitimate stores flagged by mistake: ${falseFlags} of ${legit.length}
Sketchy stores missed:                ${missed} of ${bad.length}
Errors:                               ${errors}
Slowest store:                        ${slowest}s
Tokens: ${tokensIn} in, ${tokensOut} out ≈ $${(tokensIn * PRICE_IN + tokensOut * PRICE_OUT).toFixed(2)}`);
