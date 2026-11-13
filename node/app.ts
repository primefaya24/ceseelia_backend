import express, { Express } from 'express';
import cors, { CorsOptions } from 'cors';
import { CORS_ORIGINS, IN_DEV, TRUST_PROXY_HOPS } from './config';
import { appConstants } from './constants';
import { domainRouterWithLogger } from './middleware';
import { handleBillingWebhook } from './layers/payments/billing-webhook';

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

export function createApp(): Express {
    const app: Express = express();
    app.set('trust proxy', TRUST_PROXY_HOPS);
    app.disable('x-powered-by');

    app.use(cors(buildCorsOptions()));

    // Stripe webhook (needs the raw body, so it must be registered before express.json()).
    // Payments are not implemented yet (roadmap Stage 5) — respond explicitly instead of hanging.
    app.post(
        "/api/v1/website/listen-to-stripe-event/:websiteId",
        express.raw({ type: "application/json" }),
        (_req, res) => {
            res.status(appConstants.HTTP_STATUS_CODE_NOT_IMPLEMENTED).send({ message: "Not implemented" });
        }
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
