import express, { Express } from 'express';
import cors, { CorsOptions } from 'cors';
import helmet from 'helmet';
import { CORS_ORIGINS, IN_DEV, STORE_URL_TEMPLATE, TRUST_PROXY_HOPS } from './config';
import { isValidSlug } from './constants/slug';
import { slugFromStoreOrigin, slugFromCustomOrigin } from './layers/core/store-url';
import { domainRouter } from './middleware';
import { requestLogger } from './layers/core/logger';
import {
    apiRateLimit,
    bodyErrorHandler,
    finalErrorHandler,
    jsonBodyParsers,
    PUBLIC_READ_PATHS,
    publicReadRateLimit,
} from './layers/core/http/api-limits';
import { handleBillingWebhook } from './layers/payments/billing-webhook';
import { handleConnectWebhook } from './layers/payments/order-webhook';

/*
* CORS: explicit allow-list from CORS_ORIGINS plus every store's own address (STORE_URL_TEMPLATE,
* 9.8 phase 1: `https://<slug>.ceseelia.com`); in dev with no list, reflect any origin.
*/
export function buildCorsOptions(
    allowedOrigins: string[] = CORS_ORIGINS,
    inDev: boolean = IN_DEV,
    storeTemplate: string = STORE_URL_TEMPLATE
): CorsOptions {
    if (allowedOrigins.length === 0 && inDev) {
        return { origin: true, credentials: true };
    }
    return {
        origin: (origin, callback) => {
            // Non-browser requests (curl, server-to-server, Stripe) send no Origin header
            if (
                !origin ||
                allowedOrigins.includes(origin) ||
                isValidSlug(slugFromStoreOrigin(origin, storeTemplate)) ||
                slugFromCustomOrigin(origin) !== null // 9.8 phase 2: a store's live own domain
            ) {
                return callback(null, true);
            }
            return callback(null, false);
        },
        credentials: true,
    };
}

/*
 * 9.3: set by index.ts when the server starts shutting down, so /healthz answers 503 and the
 * load balancer or Docker stops sending traffic while in-flight requests finish.
 */
let shuttingDown = false;
export function markShuttingDown(): void {
    shuttingDown = true;
}

export function createApp(): Express {
    const app: Express = express();
    app.set('trust proxy', TRUST_PROXY_HOPS);
    app.disable('x-powered-by');

    // 9.1: request id + one log line per request; first, so everything after runs in its context.
    app.use(requestLogger);

    // S.14: standard security headers. The API serves JSON to the webapp on another origin, so
    // its responses may be read cross-origin (CORS still decides who may call it).
    app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

    // 9.3: liveness for Docker's HEALTHCHECK and nginx, before host routing (the container is
    // probed as localhost). No auth, no data, never cached.
    app.get('/healthz', (_req, res) => {
        res.set('Cache-Control', 'no-store');
        if (shuttingDown) {
            res.status(503).send({ ok: false, shuttingDown: true });
            return;
        }
        res.send({ ok: true });
    });

    app.use(cors(buildCorsOptions()));

    // Stripe webhooks need the raw body (the signature is over it): registered before express.json().
    // Shopper orders (5.5): events from the stores' connected accounts, signed with webhookSecret.
    app.post(
        "/api/v1/payments/stripe-connect-webhook",
        express.raw({ type: "application/json", limit: "1mb" }),
        (req, res) => void handleConnectWebhook(req, res)
    );

    // Subscriptions (P.5): the platform account's Billing events, signed with billingWebhookSecret.
    app.post(
        "/api/v1/billing/stripe-webhook",
        express.raw({ type: "application/json", limit: "1mb" }),
        (req, res) => void handleBillingWebhook(req, res)
    );

    // 9.2: per-IP limits (after CORS so a 429 is readable by the webapp, before body parsing so a
    // flood isn't parsed), then JSON bodies capped at 100 KB (256 KB for the two big forms).
    app.use("/api/v1", apiRateLimit());
    app.use(PUBLIC_READ_PATHS, publicReadRateLimit());
    jsonBodyParsers(app);
    app.use(bodyErrorHandler);

    // Host-based routing to /api/v1
    app.use(domainRouter);

    app.use(finalErrorHandler);

    return app;
}
