// Imports
import dotenv from 'dotenv';
dotenv.config();
import { appConstants } from '../constants';

/*
* Env helpers
*/
function env(name: string, fallback: string = ""): string {
    const value = process.env[name];
    return value !== undefined && value.trim().length > 0 ? value.trim() : fallback;
}

function envList(name: string, fallback: string[] = []): string[] {
    const value = env(name);
    if (!value) {
        return fallback;
    }
    return value.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
}

function envNumber(name: string, fallback: number): number {
    const parsed = Number(env(name));
    return Number.isFinite(parsed) && env(name) !== "" ? parsed : fallback;
}

/*
* Environment
*/
const stageValue: string = env("STAGE", appConstants.STAGE_DEV);
if (stageValue !== appConstants.STAGE_DEV && stageValue !== appConstants.STAGE_PROD) {
    throw new Error(`Invalid STAGE "${stageValue}". Expected "${appConstants.STAGE_DEV}" or "${appConstants.STAGE_PROD}".`);
}
export const STAGE: string = stageValue;
export const IN_DEV: boolean = STAGE === appConstants.STAGE_DEV;
export const localServerIp: string = env("HOST", "0.0.0.0");
export const PORT: number = envNumber("PORT", 3100);

/*
* Http
*/
// Hostnames whose requests are routed to the API (in dev, localhost and this machine's IPs are also accepted)
export const ALLOWED_API_HOSTS: string[] = envList("ALLOWED_API_HOSTS", ["api.ceseelia.com"])
    .map((h) => h.toLowerCase());
// Browser origins allowed by CORS. Empty in dev = reflect any origin. Required in prod.
export const CORS_ORIGINS: string[] = envList("CORS_ORIGINS");
// Proxies in front of the API (nginx = 1). Express then derives req.ip from X-Forwarded-For
// counting only that many trusted hops, so a client-sent header can't fake the IP.
export const TRUST_PROXY_HOPS: number = envNumber("TRUST_PROXY_HOPS", 1);
// Base URL of the webapp, for links in emails (store invites, progress.md 1.4)
export const WEBAPP_URL: string = env(
    "WEBAPP_URL",
    stageValue === appConstants.STAGE_DEV ? "http://localhost:4200" : "https://app.ceseelia.com"
).replace(/\/+$/, "");

/*
* DynamoDB
*/
export const DB_TABLE_NAME: string = env("DB_TABLE_NAME", `${appConstants.DYNAMO_TABLE_PREFIX}${STAGE}`);

/*
* Cognito (pool/client ids are public identifiers; the client secret is not)
*/
const COGNITO_DEFAULTS = IN_DEV
    ? { poolId: "us-east-1_8P3eUW341", clientId: "5ilcur5227oa17kk48nifucnbp" }
    : { poolId: "us-east-1_YLhkkYbV5", clientId: "1vj29aaq6grofl14ehfc43v580" };
export const COGNITO_USER_POOL_ID: string = env("COGNITO_USER_POOL_ID", COGNITO_DEFAULTS.poolId);
export const COGNITO_USER_POOL_CLIENT_ID: string = env("COGNITO_USER_POOL_CLIENT_ID", COGNITO_DEFAULTS.clientId);
export const COGNITO_USER_POOL_CLIENT_SECRET: string = env("COGNITO_USER_POOL_CLIENT_SECRET");
// Hosted UI token endpoint, only needed for federated (social) sign-in, e.g. https://auth.example.com/oauth2/token
export const COGNITO_AUTH_DOMAIN: string = env("COGNITO_AUTH_DOMAIN");
export const COGNITO_FEDERATION_REDIRECT_URL: string = env("COGNITO_FEDERATION_REDIRECT_URL");

/*
* Stripe (5.2). The keys live in AWS Secrets Manager, never in env files or git: a JSON secret
* { "secretKey": "sk_…" | "rk_…", "webhookSecret": "whsec_…", "billingWebhookSecret": "whsec_…" }
* read once at startup by layers/payments/stripe. Dev must use a test-mode key.
* `billingWebhookSecret` signs the platform's subscription webhook (P.5); `webhookSecret` is
* for the Connect (shopper orders) endpoint (5.4).
*/
export const STRIPE_SECRET_ID: string = env("STRIPE_SECRET_ID", `ceseelia/${STAGE}/stripe`);

/*
* Paid plans (P.5): SPARK / NOVA can be picked only when this is on, which needs the Billing
* prices to exist in Stripe (`scripts/setup-billing-prices.mjs`). On by default in dev; prod
* must turn it on with PAID_PLANS_ENABLED=true once the prices, webhook and portal are set up.
*/
export const PAID_PLANS_ENABLED: boolean = env("PAID_PLANS_ENABLED", IN_DEV ? "true" : "false").toLowerCase() === "true";

/* How often expired payment grace periods are checked (P.5). */
export const BILLING_GRACE_SWEEP_INTERVAL: number = 60 * 60 * 1000;

/*
* S3
*/
export const S3_STORAGE_BUCKET_NAME: string = env("S3_STORAGE_BUCKET_NAME", `${appConstants.S3_STORAGE_BUCKET_PREFIX}${STAGE}`);
// Public origin (CDN) of the storage bucket, with trailing slash
export const S3_STORAGE_BUCKET_ORIGIN: string = withTrailingSlash(
    env("S3_STORAGE_BUCKET_ORIGIN", `https://${STAGE}.storage.ceseelia.com/`)
);

/*
* ServerWatch
*/
export const SERVER_WATCH_CHECK_FOR_LOST_ORDERS_INTERVAL: number = 10 * 60 * 1000;

/*
* Fail fast on missing production configuration
*/
if (!IN_DEV) {
    const missing: string[] = [];
    if (CORS_ORIGINS.length === 0) missing.push("CORS_ORIGINS");
    if (ALLOWED_API_HOSTS.length === 0) missing.push("ALLOWED_API_HOSTS");
    if (missing.length > 0) {
        throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);
    }
}

function withTrailingSlash(url: string): string {
    return url.endsWith("/") ? url : `${url}/`;
}
