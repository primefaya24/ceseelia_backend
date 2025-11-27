import express, { Express } from 'express';
import * as appConfig from './config/index';
import apiRouter from "./api/v1";
const cookieParser = require('cookie-parser');
const cors = require('cors');
import {DQS} from "./layers/core/utils/dqs/dqs";
import {dqsHandler} from "./layers/core/utils/dqs";

const app: Express = express();

// Cookies & Cors Middlewares
app.use(cookieParser());
app.use(cors({
    origin: true,
    credentials: true,
}));


// Stripe webhook route (raw body required)
app.post(
    "/api/v1/website/listen-to-stripe-event/:websiteId",
    express.raw({ type: "application/json" }),
    (req, res) => {
        dqs.enqueue({
            topicId: appConstants.SQS_MESSAGE_TOPIC_ID_WOO_HANDLE_STRIPE_EVENT,
            data: {
                "req": req,
                "res": res
            }
        });
    }
);

// DQS
export const dqs: DQS = new DQS(dqsHandler);

// Http Routes
import {domainRouterWithLogger} from "./middleware";
import {appConstants} from "./constants";

// Api Routers
const apiV1Router = express.Router();
apiV1Router.use('/api/v1', apiRouter);

// Middleware to route based on hostname
app.use(domainRouterWithLogger);

// Start Server
app.listen(appConfig.PORT, appConfig.localServerIp, () => {
    console.warn(`⚡️[server]: Server is running at http://${appConfig.localServerIp}:${appConfig.PORT}`);
});
