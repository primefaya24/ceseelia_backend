// Store order management (Stage 6): any member of the store (MERCHANT or ADMIN) and platform admins.
import { Router } from "express";
import route_list from "./list/index";
import route_get from "./get/index";
import route_update_status from "./update-status/index";
import route_refund from "./refund/index";

const storeOrdersRouter: Router = Router();

route_list(storeOrdersRouter);
route_get(storeOrdersRouter);
route_update_status(storeOrdersRouter);
route_refund(storeOrdersRouter);

export default storeOrdersRouter;
