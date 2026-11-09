// Public (no sign-in) store routes
import { Router } from "express";
import route_resolve_slug from "./resolve-slug/index";

const storePublicRouter: Router = Router();

route_resolve_slug(storePublicRouter);

export default storePublicRouter;
