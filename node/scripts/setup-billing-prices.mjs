// Stripe Billing setup (progress.md P.5): one product per paid plan and a monthly price per
// currency, found by lookup key (`ceseelia_spark_cad` …), with the amounts from PLANS
// (layers/core/plans). Safe to run more than once: prices that already match are left alone.
//
//   npm run build                                  # PLANS is read from dist/
//   node scripts/setup-billing-prices.mjs          # dry run: shows what it would do
//   node scripts/setup-billing-prices.mjs --write  # create what's missing
//   STRIPE_SECRET_ID=ceseelia/prod/stripe node scripts/setup-billing-prices.mjs --write
//
// The key is read from Secrets Manager (the same secret the API uses). A price whose amount
// changed in PLANS gets a new price that takes over the lookup key (`transfer_lookup_key`):
// new subscriptions use it; existing ones keep the old price until moved in the dashboard.
// Prices are tax-exclusive: Stripe Tax adds GST/HST on top at checkout.
import { createRequire } from "node:module";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import Stripe from "stripe";

const require = createRequire(import.meta.url);
const { PLANS, STORE_PLANS, isPaidPlan, planPriceLookupKey } = require("../dist/layers/core/plans/index.js");

const WRITE = process.argv.includes("--write");
const SECRET_ID = process.env.STRIPE_SECRET_ID || "ceseelia/dev/stripe";
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || "us-east-1" });
const { secretKey } = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }))).SecretString);
const stripe = new Stripe(secretKey);
console.log(`${secretKey.includes("_live_") ? "LIVE" : "test"} mode · ${WRITE ? "writing" : "dry run"}`);

const products = [];
for await (const p of stripe.products.list({ active: true, limit: 100 })) products.push(p);

for (const plan of STORE_PLANS.filter(isPaidPlan)) {
  const def = PLANS[plan];
  let product = products.find((p) => p.metadata?.ceseelia_plan === plan);
  if (!product) {
    console.log(`+ product "Ceseelia ${def.name}"`);
    if (WRITE) {
      product = await stripe.products.create({
        name: `Ceseelia ${def.name}`,
        description: `${def.name} plan for one Ceseelia store`,
        metadata: { ceseelia_plan: plan },
      });
    }
  }
  for (const [currency, amount] of Object.entries(def.monthlyPriceMinor)) {
    const key = planPriceLookupKey(plan, currency);
    const { data } = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
    const price = data[0];
    const ok =
      price &&
      price.unit_amount === amount &&
      price.currency === currency.toLowerCase() &&
      price.recurring?.interval === "month" &&
      price.recurring?.interval_count === 1;
    if (ok) {
      console.log(`= ${key} ${amount} ${currency}/month`);
      continue;
    }
    console.log(`${price ? "~" : "+"} ${key} ${amount} ${currency}/month${price ? ` (was ${price.unit_amount})` : ""}`);
    if (WRITE && product) {
      await stripe.prices.create({
        product: product.id,
        currency: currency.toLowerCase(),
        unit_amount: amount,
        recurring: { interval: "month", interval_count: 1 },
        tax_behavior: "exclusive",
        lookup_key: key,
        transfer_lookup_key: true,
        metadata: { ceseelia_plan: plan },
      });
    }
  }
}
console.log(WRITE ? "Done." : "Dry run: nothing was changed. Add --write to apply.");
