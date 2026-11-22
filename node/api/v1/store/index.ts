// Imports
import { Router } from "express";
import dotenv from "dotenv";
import storeInventoryRouter from "./inventory";
import storeCategoryRouter from "./category";
import storeParameterRouter from "./parameter";
import storePublicRouter from "./public";
import storePaymentsRouter from "./payments";
import storeGoLiveRouter from "./go-live";
import storeBillingRouter from "./billing";
import storeOrdersRouter from "./orders";
import storeCustomersRouter from "./customers";
import storeReviewsRouter from "./reviews";
import storeMessagesRouter from "./messages";
import registerDomainRoutes from "./domain";
import route_create from './create/index';
import route_delete from './delete/index';
import route_get_header_strip_image_upload_url from './get-header-strip-image-upload-url/index';
import route_get_logo_upload_url from './get-logo-upload-url/index';
import route_get_promo_image_upload_urls from './get-promo-image-upload-urls/index';
import route_update_settings from './update-settings/index';
import route_update_info from './update-info/index';
import route_overview from './overview/index';
dotenv.config();

// User Router
const storeRouter: Router = Router();

// Routes
route_create(storeRouter);
route_delete(storeRouter);
route_get_header_strip_image_upload_url(storeRouter);
route_get_logo_upload_url(storeRouter);
route_get_promo_image_upload_urls(storeRouter);
route_update_settings(storeRouter);
route_update_info(storeRouter);
route_overview(storeRouter); // L.6 Store Overview
// Paths
storeRouter.use("/category", storeCategoryRouter);
storeRouter.use("/parameter", storeParameterRouter); // Stage R
storeRouter.use("/inventory", storeInventoryRouter);
storeRouter.use("/public", storePublicRouter);
storeRouter.use("/payments", storePaymentsRouter);
storeRouter.use("/go-live", storeGoLiveRouter);
storeRouter.use("/billing", storeBillingRouter);
storeRouter.use("/orders", storeOrdersRouter);
storeRouter.use("/customers", storeCustomersRouter);
storeRouter.use("/reviews", storeReviewsRouter);
storeRouter.use("/messages", storeMessagesRouter); // L.10 messages
const storeDomainRouter: Router = Router();
registerDomainRoutes(storeDomainRouter);
storeRouter.use("/domain", storeDomainRouter); // 9.8 phase 2 custom domains

// Export Router
export default storeRouter;
