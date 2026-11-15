import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { APP_SECRET_ID } from "../../../config";

/*
 * The app's secrets: ONE Secrets Manager secret per stage, `ceseelia/dev` and `ceseelia/prod`
 * (`APP_SECRET_ID`), a flat JSON object so it can be edited in the console's key/value view:
 *
 *   stripeSecretKey             sk_… / rk_…   (5.2; test mode in dev)
 *   stripeWebhookSecret         whsec_…       Connect endpoint, shopper orders (5.5)
 *   stripeBillingWebhookSecret  whsec_…       platform endpoint, subscriptions (P.5)
 *   anthropicApiKey             sk-ant-…      the AI store check (L.2)
 *
 * Read once and cached; a failed read isn't cached, so the next call tries again. Values are
 * never logged: errors name the secret and the AWS error, nothing else.
 */
export class AppSecretsUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AppSecretsUnavailableError";
  }
}

let cached: Promise<string | undefined> | null = null;

/* The secret's raw JSON string. Throws AppSecretsUnavailableError if it can't be read. */
export function readAppSecretString(): Promise<string | undefined> {
  if (!cached) {
    const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || "us-east-1" });
    cached = sm
      .send(new GetSecretValueCommand({ SecretId: APP_SECRET_ID }))
      .then((r) => r.SecretString)
      .catch((e) => {
        cached = null;
        const name = (e as { name?: string })?.name ?? "Error";
        throw new AppSecretsUnavailableError(`can't read secret "${APP_SECRET_ID}" (${name})`);
      });
  }
  return cached;
}

/* Tests only. */
export function resetAppSecretsForTests(): void {
  cached = null;
}
