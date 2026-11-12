import * as appConfig from './config/index';
import { createApp } from './app';
import { checkStripeConfig } from './layers/payments/stripe';

const app = createApp();

// Prod refuses to start without a usable Stripe key (5.2); dev only warns.
checkStripeConfig()
    .then(() => {
        app.listen(appConfig.PORT, appConfig.localServerIp, () => {
            console.warn(`⚡️[server]: [${appConfig.STAGE}] Server is running at http://${appConfig.localServerIp}:${appConfig.PORT}`);
        });
    })
    .catch((e: Error) => {
        console.error(`[server] Not starting: ${e.message}`);
        process.exit(1);
    });
