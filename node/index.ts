import * as appConfig from './config/index';
import { createApp, markShuttingDown } from './app';
import { checkStripeConfig } from './layers/payments/stripe';
import { sweepExpiredGrace } from './layers/payments/subscription-sync';
import { sweepLostOrders } from './layers/payments/order-sweep';
import { sweepItemChecks } from './layers/core/store-validation/item-check';
import { sweepMessageEmails } from './layers/notifications/message-notify';
import { registerTimer } from './layers/core/utils';
import { log } from "./layers/core/logger";

const app = createApp();
const timers: ReturnType<typeof setInterval>[] = [];

/* 9.3: how long in-flight requests get to finish after SIGTERM before the process exits. */
const SHUTDOWN_GRACE_MS = 10_000;

// Prod refuses to start without a usable Stripe key (5.2); dev only warns.
checkStripeConfig()
    .then(() => {
        const server = app.listen(appConfig.PORT, appConfig.localServerIp, () => {
            log.info({ host: appConfig.localServerIp, port: appConfig.PORT }, '[server] running');
            // P.5: stores whose payment grace ended lose their plan, live → draft (one server; see progress.md).
            timers.push(registerTimer(appConfig.BILLING_GRACE_SWEEP_INTERVAL, async () => {
                const n = await sweepExpiredGrace();
                if (n > 0) log.info({ stores: n }, '[billing] grace sweep re-synced stores');
            }));
            // 5.7: orders whose Checkout ended without a webhook (paid → PAID, else CANCELLED).
            timers.push(registerTimer(appConfig.SERVER_WATCH_CHECK_FOR_LOST_ORDERS_INTERVAL, async () => {
                const r = await sweepLostOrders();
                if (r.paid + r.cancelled + r.failed > 0) {
                    log[r.failed > 0 ? 'warn' : 'info']({ ...r }, '[order sweep] done');
                }
            }));
            // L.2: the AI check of live stores' new and changed items.
            timers.push(registerTimer(appConfig.ITEM_CHECK_SWEEP_INTERVAL, async () => {
                const r = await sweepItemChecks();
                if (r.checked + r.failed > 0) {
                    log[r.failed > 0 ? 'warn' : 'info']({ ...r }, '[item check] done');
                }
            }));
            // L.10: email stores about shopper messages nobody has read for 30 minutes.
            timers.push(registerTimer(appConfig.MESSAGE_EMAIL_SWEEP_INTERVAL, async () => {
                const r = await sweepMessageEmails();
                if (r.sent + r.failed > 0) {
                    log[r.failed > 0 ? 'warn' : 'info']({ ...r }, '[messages] store email sweep');
                }
            }));
        });

        // 9.3 graceful shutdown: `docker compose up` / stop sends SIGTERM. Stop the sweeps, refuse
        // new connections, let in-flight requests (a webhook, a refund) finish, then exit.
        let stopping = false;
        const shutdown = (signal: string) => {
            if (stopping) return;
            stopping = true;
            log.info({ signal }, '[server] shutting down');
            markShuttingDown();
            timers.forEach(clearInterval);
            server.close(() => {
                log.info('[server] closed cleanly');
                process.exit(0);
            });
            server.closeIdleConnections();
            setTimeout(() => {
                log.error(`[server] still busy after ${SHUTDOWN_GRACE_MS} ms; exiting`);
                process.exit(1);
            }, SHUTDOWN_GRACE_MS).unref();
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((e: Error) => {
        log.error(`[server] Not starting: ${e.message}`);
        process.exit(1);
    });
