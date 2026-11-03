import * as appConfig from './config/index';
import { createApp } from './app';

const app = createApp();

app.listen(appConfig.PORT, appConfig.localServerIp, () => {
    console.warn(`⚡️[server]: [${appConfig.STAGE}] Server is running at http://${appConfig.localServerIp}:${appConfig.PORT}`);
});
