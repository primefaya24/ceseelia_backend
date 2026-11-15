import * as appConfig from './config/index';
import { createApp, markShuttingDown } from './app';
import { checkStripeConfig } from './layers/payments/stripe';
import { sweepExpiredGrace } from './layers/payments/subscription-sync';
import { sweepLostOrders } from './layers/payments/order-sweep';
import { sweepItemChecks } from './layers/core/store-validation/item-check';
import { registerTimer } from './layers/core/utils';

const app = createApp();
const timers: ReturnType<typeof setInterval>[] = [];

/* 9.3: how long in-flight requests get to finish after SIGTERM before the process exits. */
const SHUTDOWN_GRACE_MS = 10_000;

// Prod refuses to start without a usable Stripe key (5.2); dev only warns.
checkStripeConfig()
    .then(() => {
        const server = app.listen(appConfig.PORT, appConfig.localServerIp, () => {
            console.warn(`⚡️[server]: [${appConfig.STAGE}] Server is running at http://${appConfig.localServerIp}:${appConfig.PORT}`);
            // P.5: stores whose payment grace ended lose their plan, live → draft (one server; see progress.md).
            timers.push(registerTimer(appConfig.BILLING_GRACE_SWEEP_INTERVAL, async () => {
                const n = await sweepExpiredGrace();
                if (n > 0) console.warn(`[billing] grace sweep: ${n} store(s) re-synced`);
            }));
            // 5.7: orders whose Checkout ended without a webhook (paid → PAID, else CANCELLED).
            timers.push(registerTimer(appConfig.SERVER_WATCH_CHECK_FOR_LOST_ORDERS_INTERVAL, async () => {
                const r = await sweepLostOrders();
                if (r.paid + r.cancelled + r.failed > 0) {
                    console.warn(`[order sweep] checked ${r.checked}: ${r.paid} paid, ${r.cancelled} cancelled, ${r.cleared} cleared, ${r.kept} kept, ${r.failed} failed`);
                }
            }));
            // L.2: the AI check of live stores' new and changed items.
            timers.push(registerTimer(appConfig.ITEM_CHECK_SWEEP_INTERVAL, async () => {
                const r = await sweepItemChecks();
                if (r.checked + r.failed > 0) {
                    console.warn(`[item check] ${r.checked} checked: ${r.flagged} hidden, ${r.cleared} shown again, ${r.skipped} skipped, ${r.failed} failed`);
                }
            }));
        });

        // 9.3 graceful shutdown: `docker compose up` / stop sends SIGTERM. Stop the sweeps, refuse
        // new connections, let in-flight requests (a webhook, a refund) finish, then exit.
        let stopping = false;
        const shutdown = (signal: string) => {
            if (stopping) return;
            stopping = true;
            console.warn(`[server] ${signal}: shutting down`);
            markShuttingDown();
            timers.forEach(clearInterval);
            server.close(() => {
                console.warn('[server] closed cleanly');
                process.exit(0);
            });
            server.closeIdleConnections();
            setTimeout(() => {
                console.error(`[server] still busy after ${SHUTDOWN_GRACE_MS} ms; exiting`);
                process.exit(1);
            }, SHUTDOWN_GRACE_MS).unref();
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((e: Error) => {
        console.error(`[server] Not starting: ${e.message}`);
        process.exit(1);
    });
