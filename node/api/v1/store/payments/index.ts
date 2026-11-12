// Store payments routes (5.2): the store's Stripe Connect (Standard) account
import { Router } from "express";
import route_create_connect_account_link from "./create-connect-account-link/index";
import route_status from "./status/index";

const storePaymentsRouter: Router = Router();

route_create_connect_account_link(storePaymentsRouter);
route_status(storePaymentsRouter);

export default storePaymentsRouter;
