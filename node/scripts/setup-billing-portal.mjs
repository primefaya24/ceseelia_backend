// Stripe customer portal: how plan switches are billed (P.5 setup, owner decision 2026-11-16).
//   Upgrades (Spark → Nova) switch now and the difference for the rest of the month is charged
//   at once (`always_invoice`). Downgrades (Nova → Spark) wait until the period ends, so a store
//   keeps what it paid for; our webhook follows the subscription when Stripe makes the switch.
// Changes the default portal configuration (the one `billingPortal.sessions.create` uses).
// The key is read from Secrets Manager and never printed.
//   APP_SECRET_ID=ceseelia/prod node scripts/setup-billing-portal.mjs          # dry run
//   APP_SECRET_ID=ceseelia/prod node scripts/setup-billing-portal.mjs --write  # apply
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import Stripe from "stripe";

const WRITE = process.argv.includes("--write");
const SECRET_ID = process.env.APP_SECRET_ID || "ceseelia/dev";
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || "us-east-1" });
const { stripeSecretKey: secretKey } = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }))).SecretString);
const stripe = new Stripe(secretKey);
console.log(`${SECRET_ID} · ${secretKey.includes("_live_") ? "LIVE" : "test"} mode · ${WRITE ? "writing" : "dry run"}`);

const configs = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 });
const config = configs.data[0];
if (!config) throw new Error("No default portal configuration: save the customer portal once in the dashboard.");
const show = (c) => {
  const u = c.features.subscription_update;
  return {
    id: c.id,
    switchPlans: u.enabled,
    proration: u.proration_behavior,
    atPeriodEnd: (u.schedule_at_period_end?.conditions ?? []).map((x) => x.type),
    cancel: c.features.subscription_cancel.enabled ? c.features.subscription_cancel.mode : "off",
  };
};
console.log("now:   ", show(config));

const want = {
  features: {
    subscription_update: {
      proration_behavior: "always_invoice",
      schedule_at_period_end: { conditions: [{ type: "decreasing_item_amount" }, { type: "shortening_interval" }] },
    },
  },
};
if (!WRITE) {
  console.log("would set: proration always_invoice; downgrades at period end. Run with --write.");
} else {
  const updated = await stripe.billingPortal.configurations.update(config.id, want);
  console.log("after: ", show(updated));
}
