import Stripe from "stripe";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { IN_DEV, STRIPE_SECRET_ID } from "../../config";

/*
 * The platform's Stripe client (5.2). The secret key is read once from AWS Secrets Manager
 * (`STRIPE_SECRET_ID`, JSON `{ secretKey, webhookSecret }`) and never logged. Dev refuses a
 * live-mode key, so local testing can't move real money.
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
  const secretKey = typeof d.secretKey === "string" ? d.secretKey.trim() : "";
  const webhookSecret = typeof d.webhookSecret === "string" ? d.webhookSecret.trim() : "";
  const billingWebhookSecret = typeof d.billingWebhookSecret === "string" ? d.billingWebhookSecret.trim() : "";
  if (!KEY_PATTERN.test(secretKey))
    throw new PaymentsNotConfiguredError("secretKey is missing or not a Stripe key");
  if (inDev && secretKey.includes("_live_")) {
    throw new PaymentsNotConfiguredError("dev must use a test-mode key, not a live one");
  }
  return { secretKey, webhookSecret, billingWebhookSecret };
}

let secretsPromise: Promise<StripeSecrets> | null = null;
let clientPromise: Promise<Stripe> | null = null;

async function loadSecrets(): Promise<StripeSecrets> {
  const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || "us-east-1" });
  let raw: string | undefined;
  try {
    raw = (await sm.send(new GetSecretValueCommand({ SecretId: STRIPE_SECRET_ID }))).SecretString;
  } catch (e) {
    const name = (e as { name?: string })?.name ?? "Error";
    throw new PaymentsNotConfiguredError(`can't read secret "${STRIPE_SECRET_ID}" (${name})`);
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
    console.warn(
      `[stripe] ${mode} key loaded from "${STRIPE_SECRET_ID}"${webhookSecret ? "" : " (no webhook secret yet)"}`
    );
  } catch (e) {
    if (!IN_DEV) throw e;
    console.warn(`[stripe] ${(e as Error).message}. Payments routes will answer 503.`);
  }
}

/* Tests only: forget the cached secrets and client. */
export function resetStripeForTests(): void {
  secretsPromise = null;
  clientPromise = null;
}
