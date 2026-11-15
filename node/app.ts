import express, { Express } from 'express';
import cors, { CorsOptions } from 'cors';
import helmet from 'helmet';
import { CORS_ORIGINS, IN_DEV, TRUST_PROXY_HOPS } from './config';
import { domainRouterWithLogger } from './middleware';
import { handleBillingWebhook } from './layers/payments/billing-webhook';
import { handleConnectWebhook } from './layers/payments/order-webhook';

/*
* CORS: explicit allow-list from CORS_ORIGINS; in dev with no list, reflect any origin.
*/
export function buildCorsOptions(allowedOrigins: string[] = CORS_ORIGINS, inDev: boolean = IN_DEV): CorsOptions {
    if (allowedOrigins.length === 0 && inDev) {
        return { origin: true, credentials: true };
    }
    return {
        origin: (origin, callback) => {
            // Non-browser requests (curl, server-to-server, Stripe) send no Origin header
            if (!origin || allowedOrigins.includes(origin)) {
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

    app.use(express.json({ limit: "1mb" }));

    // Host-based routing to /api/v1
    app.use(domainRouterWithLogger);

    return app;
}
