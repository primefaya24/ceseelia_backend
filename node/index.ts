import * as appConfig from './config/index';
import { createApp } from './app';
import { checkStripeConfig } from './layers/payments/stripe';
import { sweepExpiredGrace } from './layers/payments/subscription-sync';
import { sweepLostOrders } from './layers/payments/order-sweep';
import { registerTimer } from './layers/core/utils';

const app = createApp();

// Prod refuses to start without a usable Stripe key (5.2); dev only warns.
checkStripeConfig()
    .then(() => {
        app.listen(appConfig.PORT, appConfig.localServerIp, () => {
            console.warn(`⚡️[server]: [${appConfig.STAGE}] Server is running at http://${appConfig.localServerIp}:${appConfig.PORT}`);
            // P.5: stores whose payment grace ended lose their plan, live → draft (one server; see progress.md).
            registerTimer(appConfig.BILLING_GRACE_SWEEP_INTERVAL, async () => {
                const n = await sweepExpiredGrace();
                if (n > 0) console.warn(`[billing] grace sweep: ${n} store(s) re-synced`);
            });
            // 5.7: orders whose Checkout ended without a webhook (paid → PAID, else CANCELLED).
            registerTimer(appConfig.SERVER_WATCH_CHECK_FOR_LOST_ORDERS_INTERVAL, async () => {
                const r = await sweepLostOrders();
                if (r.paid + r.cancelled + r.failed > 0) {
                    console.warn(`[order sweep] checked ${r.checked}: ${r.paid} paid, ${r.cancelled} cancelled, ${r.cleared} cleared, ${r.kept} kept, ${r.failed} failed`);
                }
            });
        });
    })
    .catch((e: Error) => {
        console.error(`[server] Not starting: ${e.message}`);
        process.exit(1);
    });
