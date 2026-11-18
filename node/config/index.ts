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
// 9.8 phase 1: every store's own address, `{slug}` replaced by its slug. Shopper links (Stripe
// return, order emails, link previews) use it, and CORS accepts it. Empty = no store subdomains:
// links are `${WEBAPP_URL}/s/<slug>` (the dev default; a local test can use
// `http://{slug}.localhost:4200`). Must be `http(s)://{slug}.<host>[:port]`.
export const STORE_URL_TEMPLATE: string = env(
    "STORE_URL_TEMPLATE",
    stageValue === appConstants.STAGE_DEV ? "" : "https://{slug}.ceseelia.com"
).replace(/\/+$/, "");

// 9.8 phase 2: stores' own domains (shop.theirbrand.com). The multi-tenant CloudFront
// distribution and connection group come from the CloudFormation stack's outputs
// (CustomDomainDistributionId / CustomDomainConnectionGroupId); without them the feature is off
// (setup answers 503, nothing is swept). CUSTOM_DOMAIN_TARGET is what merchants CNAME to.
export const CUSTOM_DOMAIN_DISTRIBUTION_ID: string = env("CUSTOM_DOMAIN_DISTRIBUTION_ID", "");
export const CUSTOM_DOMAIN_CONNECTION_GROUP_ID: string = env("CUSTOM_DOMAIN_CONNECTION_GROUP_ID", "");
export const CUSTOM_DOMAIN_TARGET: string = env(
    "CUSTOM_DOMAIN_TARGET",
    stageValue === appConstants.STAGE_DEV ? "" : "domains.ceseelia.com"
).toLowerCase().replace(/\.$/, "");
export const CUSTOM_DOMAINS_ENABLED: boolean = CUSTOM_DOMAIN_DISTRIBUTION_ID !== "" && CUSTOM_DOMAIN_TARGET !== "";

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
* Secrets (Stripe keys and webhook secrets, the Anthropic key) live in ONE AWS Secrets Manager
* secret per stage, never in env files or git: `ceseelia/dev` or `ceseelia/prod`, a flat JSON
* object read once by layers/aws/secret-manager/app-secrets (key names listed there).
*/
/*
* L.2: where store-check alerts go (a store sent to review, items hidden on a live store).
*/
export const ADMIN_ALERT_EMAIL: string = env("ADMIN_ALERT_EMAIL", appConstants.ADMIN_CONTACT_EMAIL_ADDRESS);

export const APP_SECRET_ID: string = env("APP_SECRET_ID", `ceseelia/${STAGE}`);

/*
* Paid plans (P.5): plans can be picked only when this is on, which needs the Billing
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
/* L.2: how often the AI check looks for live stores' saved items that are due. */
export const ITEM_CHECK_SWEEP_INTERVAL: number = 60 * 1000;
/* L.10: emails to stores about shopper messages unread for 30 minutes. */
export const MESSAGE_EMAIL_SWEEP_INTERVAL: number = 60 * 1000;
/* 9.8 phase 2: stores' own domains move through DNS → certificate → live (and plan checks). */
export const CUSTOM_DOMAIN_SWEEP_INTERVAL: number = 60 * 1000;

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
    // Local testing only (kickstart): a stripe-listen signing secret must never reach prod.
    if (process.env.STRIPE_LISTEN_SECRET) {
        throw new Error("STRIPE_LISTEN_SECRET is for local testing (STAGE=dev) only");
    }
}

function withTrailingSlash(url: string): string {
    return url.endsWith("/") ? url : `${url}/`;
}
