import Stripe from "stripe";
import { APP_SECRET_ID, IN_DEV } from "../../config";
import { readAppSecretString } from "../aws/secret-manager/app-secrets";
import { log } from "../core/logger";

/*
 * The platform's Stripe client (5.2). The keys come from the stage's app secret
 * (`ceseelia/<stage>`: `stripeSecretKey`, `stripeWebhookSecret`, `stripeBillingWebhookSecret`;
 * see app-secrets.ts) and are never logged. Dev refuses a live-mode key, so local testing can't
 * move real money.
 */

/* Payments can't be used: the secret is missing, unreadable or still a placeholder. */
export class PaymentsNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`Stripe is not configured: ${reason}`);
    this.name = "PaymentsNotConfiguredError";
  }
}

export interface StripeSecrets {
  secretKey: string;
  /** Connect endpoint (shopper orders, 5.4). */
  webhookSecret: string;
  /** Platform endpoint for subscriptions (P.5); "" until it's set up. */
  billingWebhookSecret: string;
}

const KEY_PATTERN = /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/;

/* Checks the secret's shape. Throws PaymentsNotConfiguredError; messages never include the key. */
export function parseStripeSecrets(raw: string | undefined, inDev: boolean): StripeSecrets {
  let data: unknown;
  try {
    data = JSON.parse(raw ?? "");
  } catch {
    throw new PaymentsNotConfiguredError("the secret is not JSON");
  }
  const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string).trim() : "");
  const secretKey = str("stripeSecretKey");
  const webhookSecret = str("stripeWebhookSecret");
  const billingWebhookSecret = str("stripeBillingWebhookSecret");
  if (!KEY_PATTERN.test(secretKey))
    throw new PaymentsNotConfiguredError("stripeSecretKey is missing or not a Stripe key");
  if (inDev && secretKey.includes("_live_")) {
    throw new PaymentsNotConfiguredError("dev must use a test-mode key, not a live one");
  }
  return { secretKey, webhookSecret, billingWebhookSecret };
}

let secretsPromise: Promise<StripeSecrets> | null = null;
let clientPromise: Promise<Stripe> | null = null;

async function loadSecrets(): Promise<StripeSecrets> {
  let raw: string | undefined;
  try {
    raw = await readAppSecretString();
  } catch (e) {
    throw new PaymentsNotConfiguredError((e as Error).message);
  }
  return parseStripeSecrets(raw, IN_DEV);
}

/* The secrets, read once. A failed read isn't cached, so the next call tries again. */
export function getStripeSecrets(): Promise<StripeSecrets> {
  if (!secretsPromise) {
    secretsPromise = loadSecrets().catch((e) => {
      secretsPromise = null;
      throw e;
    });
  }
  return secretsPromise;
}

/* The shared Stripe client. Throws PaymentsNotConfiguredError when the key isn't usable. */
export function getStripe(): Promise<Stripe> {
  if (!clientPromise) {
    clientPromise = getStripeSecrets()
      .then(
        ({ secretKey }) =>
          new Stripe(secretKey, {
            maxNetworkRetries: 2,
            timeout: 20_000,
            appInfo: { name: "Ceseelia", url: "https://ceseelia.com" },
          })
      )
      .catch((e) => {
        clientPromise = null;
        throw e;
      });
  }
  return clientPromise;
}

/*
 * Startup check (index.ts). Prod refuses to start without a usable key; dev only warns, so the
 * rest of the API still runs and the payments routes answer 503 PAYMENTS_NOT_CONFIGURED.
 * Logs only the key's mode, never the key.
 */
export async function checkStripeConfig(): Promise<void> {
  try {
    const { secretKey, webhookSecret } = await getStripeSecrets();
    const mode = secretKey.includes("_live_") ? "live" : "test";
    log.info({ mode, secretId: APP_SECRET_ID, webhookSecret: !!webhookSecret }, "[stripe] key loaded");
  } catch (e) {
    if (!IN_DEV) throw e;
    log.warn(`[stripe] ${(e as Error).message}. Payments routes will answer 503.`);
  }
}

/* Tests only: forget the cached secrets and client. */
export function resetStripeForTests(): void {
  secretsPromise = null;
  clientPromise = null;
}
