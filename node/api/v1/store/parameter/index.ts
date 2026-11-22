// Imports
import { Router } from "express";
import route_save from "./save/index";
import route_delete from "./delete/index";

// Store parameters (Stage R): defined once per store, picked on items.
const storeParameterRouter: Router = Router();

route_save(storeParameterRouter);
route_delete(storeParameterRouter);

export default storeParameterRouter;
