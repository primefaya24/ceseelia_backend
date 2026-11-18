/*
 * The two Stripe webhook endpoints and the events each receives (BE 5.5 shopper orders on the
 * stores' connected accounts; P.5 plans and billing on the platform). Used by
 * setup-stripe-account.mjs (the real endpoints, dev and prod) and by the webapp's
 * tools/kickstart.sh (`stripe listen` on a local machine), so local testing gets the same events
 * as prod.
 */
export const webhooks = (API_BASE) => [
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
      // A downgrade at the period's end is a subscription schedule (Stage Q.4).
      "subscription_schedule.created",
      "subscription_schedule.updated",
      "subscription_schedule.released",
      "subscription_schedule.canceled",
      "subscription_schedule.completed",
      "subscription_schedule.aborted",
    ],
  },
];

/* Every event either endpoint receives (stripe listen takes one list for both). */
export const ALL_WEBHOOK_EVENTS = [...new Set(webhooks("").flatMap((h) => h.events))];
