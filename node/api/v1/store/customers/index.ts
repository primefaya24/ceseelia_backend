// Store customers (Stage 7, L.7): any member of the store and platform admins.
import { Router } from "express";
import route_list from "./list/index";

const storeCustomersRouter: Router = Router();

route_list(storeCustomersRouter);

export default storeCustomersRouter;
