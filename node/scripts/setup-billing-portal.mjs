// Stripe customer portal: how plan switches are billed (P.5 setup, owner decision 2026-11-16;
// kept for three plans in Stage Q, 2026-11-17).
//   Upgrades (Spark → Nova → Lumina) switch now and the difference for the rest of the month is
//   charged at once (`always_invoice`). Downgrades wait until the period ends, so a store keeps
//   what it paid for; our webhook follows the subscription when Stripe makes the switch.
//   The plans offered are every plan in PLANS (product + its monthly prices, found by lookup
//   key), so the portal can't drift from the code. Run setup-billing-prices.mjs first.
//   npm run build first (PLANS is read from dist/).
// Changes the default portal configuration (the one `billingPortal.sessions.create` uses).
// The key is read from Secrets Manager and never printed.
//   APP_SECRET_ID=ceseelia/prod node scripts/setup-billing-portal.mjs          # dry run
//   APP_SECRET_ID=ceseelia/prod node scripts/setup-billing-portal.mjs --write  # apply
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createRequire } from "node:module";
import Stripe from "stripe";

const require = createRequire(import.meta.url);
const { PLANS, STORE_PLANS, planPriceLookupKey } = require("../dist/layers/core/plans/index.js");

const WRITE = process.argv.includes("--write");
const SECRET_ID = process.env.APP_SECRET_ID || "ceseelia/dev";
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || "us-east-1" });
const { stripeSecretKey: secretKey } = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }))).SecretString);
const stripe = new Stripe(secretKey);
console.log(`${SECRET_ID} · ${secretKey.includes("_live_") ? "LIVE" : "test"} mode · ${WRITE ? "writing" : "dry run"}`);

// The plans list is only returned when expanded.
const EXPAND = ["features.subscription_update.products"];
const configs = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1, expand: EXPAND.map((e) => `data.${e}`) });
const config = configs.data[0];
if (!config) throw new Error("No default portal configuration: save the customer portal once in the dashboard.");
const show = (c) => {
  const u = c.features.subscription_update;
  return {
    id: c.id,
    switchPlans: u.enabled,
    plans: (u.products ?? []).map((p) => `${p.product} (${p.prices.length} prices)`),
    proration: u.proration_behavior,
    atPeriodEnd: (u.schedule_at_period_end?.conditions ?? []).map((x) => x.type),
    cancel: c.features.subscription_cancel.enabled ? c.features.subscription_cancel.mode : "off",
  };
};
console.log("now:   ", show(config));

// Every plan's product and its active prices (one per currency).
const products = [];
for await (const p of stripe.products.list({ active: true, limit: 100 })) products.push(p);
const planProducts = [];
for (const plan of STORE_PLANS) {
  const product = products.find((p) => p.metadata?.ceseelia_plan === plan);
  if (!product) throw new Error(`No product for ${plan}: run setup-billing-prices.mjs --write first.`);
  const keys = Object.keys(PLANS[plan].monthlyPriceMinor).map((c) => planPriceLookupKey(plan, c));
  const { data } = await stripe.prices.list({ lookup_keys: keys, active: true, limit: 10 });
  if (data.length !== keys.length) throw new Error(`${plan}: ${data.length} of ${keys.length} prices found: run setup-billing-prices.mjs --write first.`);
  planProducts.push({ product: product.id, prices: data.map((p) => p.id) });
  console.log(`  ${plan}: ${product.id} · ${data.map((p) => p.lookup_key).join(", ")}`);
}

const want = {
  features: {
    subscription_update: {
      enabled: true,
      default_allowed_updates: ["price"],
      products: planProducts,
      proration_behavior: "always_invoice",
      schedule_at_period_end: { conditions: [{ type: "decreasing_item_amount" }, { type: "shortening_interval" }] },
    },
  },
};
if (!WRITE) {
  console.log(`would set: ${planProducts.length} plans; proration always_invoice; downgrades at period end. Run with --write.`);
} else {
  const updated = await stripe.billingPortal.configurations.update(config.id, { ...want, expand: EXPAND });
  console.log("after: ", show(updated));
}
