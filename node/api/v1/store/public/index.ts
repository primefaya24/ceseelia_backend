// Public (no sign-in) store routes
import { Router } from "express";
import route_resolve_slug from "./resolve-slug/index";
import route_storefront from "./storefront/index";
import route_item from "./item/index";

const storePublicRouter: Router = Router();

route_resolve_slug(storePublicRouter);
route_storefront(storePublicRouter);
route_item(storePublicRouter);

export default storePublicRouter;
