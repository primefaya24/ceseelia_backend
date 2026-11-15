// Public (no sign-in) store routes
import { Router } from "express";
import route_resolve_slug from "./resolve-slug/index";
import route_storefront from "./storefront/index";
import route_item from "./item/index";
import route_plans from "./plans/index";
import route_reviews from "./reviews/index";
import route_preview from "./preview/index";

const storePublicRouter: Router = Router();

route_resolve_slug(storePublicRouter);
route_storefront(storePublicRouter);
route_item(storePublicRouter);
route_plans(storePublicRouter);
route_reviews(storePublicRouter); // L.7 / 7.5
route_preview(storePublicRouter); // L.9 / WA 3.6 link previews

export default storePublicRouter;
