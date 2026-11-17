// Stripe account setup for one stage (progress.md §0 C1/C2 and D1): what test mode got by hand,
// repeatable for live mode. Safe to run more than once: what already matches is left alone.
//
//   APP_SECRET_ID=ceseelia/prod node scripts/setup-stripe-account.mjs          # dry run
//   APP_SECRET_ID=ceseelia/prod node scripts/setup-stripe-account.mjs --write  # apply
//
// 1. Webhook endpoints (BE 5.5 Connect, P.5 billing). A new endpoint's signing secret is written
//    into the same Secrets Manager secret (`stripeWebhookSecret` / `stripeBillingWebhookSecret`)
//    and never printed. An endpoint that exists keeps its secret (Stripe shows it only once).
// 2. Stripe Tax: head office (origin address), defaults, and the Canada GST/HST registration.
// 3. The SaaS tax code on the plan products (run setup-billing-prices.mjs first).
// The key is read from the secret and never printed.
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import Stripe from "stripe";

const WRITE = process.argv.includes("--write");
const SECRET_ID = process.env.APP_SECRET_ID || "ceseelia/dev";
const API_BASE = process.env.API_BASE || "https://api.ceseelia.com/api/v1";
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || "us-east-1" });
const readSecret = async () =>
  JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }))).SecretString);
const stripe = new Stripe((await readSecret()).stripeSecretKey);
const LIVE = (await readSecret()).stripeSecretKey.includes("_live_");
console.log(`${SECRET_ID} · ${LIVE ? "LIVE" : "test"} mode · ${WRITE ? "writing" : "dry run"}`);

const SAAS_TAX_CODE = "txcd_10103001";
const HEAD_OFFICE = {
  line1: "5206 35 Street",
  city: "Lloydminster",
  state: "AB",
  postal_code: "T9V 1G9",
  country: "CA",
};

const WEBHOOKS = [
  {
    secretField: "stripeWebhookSecret",
    url: `${API_BASE}/payments/stripe-connect-webhook`,
    connect: true,
    description: "Ceseelia shopper orders (Connect, BE 5.5)",
    events: [
      "checkout.session.completed",
      "checkout.session.expired",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "charge.refunded",
      "charge.refund.updated",
      "refund.created",
      "refund.updated",
      "refund.failed",
      "charge.dispute.created",
      "charge.dispute.updated",
      "charge.dispute.closed",
      "account.updated",
    ],
  },
  {
    secretField: "stripeBillingWebhookSecret",
    url: `${API_BASE}/billing/stripe-webhook`,
    connect: false,
    description: "Ceseelia plans and billing (platform, P.5)",
    events: [
      "checkout.session.completed",
      "checkout.session.expired",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "customer.subscription.paused",
      "customer.subscription.resumed",
      "invoice.paid",
      "invoice.payment_failed",
    ],
  },
];

// 1. Webhooks
const existing = [];
for await (const w of stripe.webhookEndpoints.list({ limit: 100 })) existing.push(w);
const newSecrets = {};
for (const hook of WEBHOOKS) {
  const found = existing.find((w) => w.url === hook.url && Boolean(w.application) === hook.connect);
  if (found) {
    const missing = hook.events.filter((e) => !found.enabled_events.includes(e));
    console.log(
      `= webhook ${found.id} ${hook.url}${missing.length ? ` (adding ${missing.join(", ")})` : ""}`
    );
    if (WRITE && missing.length) {
      await stripe.webhookEndpoints.update(found.id, {
        enabled_events: [...new Set([...found.enabled_events, ...hook.events])],
      });
    }
    continue;
  }
  console.log(
    `+ webhook ${hook.connect ? "Connect" : "platform"} ${hook.url} (${hook.events.length} events) → ${hook.secretField}`
  );
  if (WRITE) {
    const created = await stripe.webhookEndpoints.create({
      url: hook.url,
      connect: hook.connect,
      enabled_events: hook.events,
      description: hook.description,
      api_version: "2025-08-27.basil", // the SDK's version, as in test mode
    });
    newSecrets[hook.secretField] = created.secret;
    console.log(`  created ${created.id}`);
  }
}
if (WRITE && Object.keys(newSecrets).length) {
  const current = await readSecret();
  await sm.send(
    new PutSecretValueCommand({
      SecretId: SECRET_ID,
      SecretString: JSON.stringify({ ...current, ...newSecrets }),
    })
  );
  console.log(`  stored ${Object.keys(newSecrets).join(", ")} in ${SECRET_ID} (values not shown)`);
}

// 2. Stripe Tax
const tax = await stripe.tax.settings.retrieve();
const officeOk = tax.head_office?.address?.postal_code === HEAD_OFFICE.postal_code;
console.log(
  `${officeOk ? "=" : "+"} tax head office ${HEAD_OFFICE.city}, ${HEAD_OFFICE.state} (status now: ${tax.status})`
);
if (WRITE && !officeOk) {
  const t = await stripe.tax.settings.update({
    head_office: { address: HEAD_OFFICE },
    defaults: { tax_behavior: "inferred_by_currency", tax_code: "txcd_10000000" },
  });
  console.log(`  tax status: ${t.status}`);
}
const regs = await stripe.tax.registrations.list({ status: "all", limit: 100 });
const gst = regs.data.find(
  (r) => r.country === "CA" && r.country_options?.ca?.type === "standard" && r.status !== "expired"
);
console.log(`${gst ? "=" : "+"} tax registration Canada GST/HST${gst ? ` (${gst.status})` : ""}`);
if (WRITE && !gst) {
  await stripe.tax.registrations.create({
    country: "CA",
    country_options: { ca: { type: "standard" } },
    active_from: "now",
  });
}

// 3. Plan products' tax code
for await (const p of stripe.products.list({ active: true, limit: 100 })) {
  if (!p.metadata?.ceseelia_plan) continue;
  const ok = p.tax_code === SAAS_TAX_CODE;
  console.log(`${ok ? "=" : "~"} product ${p.name} tax code ${SAAS_TAX_CODE}`);
  if (WRITE && !ok) await stripe.products.update(p.id, { tax_code: SAAS_TAX_CODE });
}
