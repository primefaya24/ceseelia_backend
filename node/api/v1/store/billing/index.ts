import { Router } from "express";
import route_status from "./status";
import route_checkout from "./checkout";
import route_portal from "./portal";

/* Plan subscriptions (progress.md P.5). */
const storeBillingRouter: Router = Router();
route_status(storeBillingRouter);
route_checkout(storeBillingRouter);
route_portal(storeBillingRouter);

export default storeBillingRouter;
