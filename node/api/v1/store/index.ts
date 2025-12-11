// Imports
import { Router } from "express";
import dotenv from "dotenv";
import storeInventoryRouter from "./inventory";
import storeCategoryRouter from "./category";
import storeParameterRouter from "./parameter";
dotenv.config();

// User Router
const storeRouter: Router = Router();

// Routes
require("./create/index")(storeRouter);
require("./delete/index")(storeRouter);
require("./update-settings/index")(storeRouter);

// Paths
storeRouter.use("/category", storeCategoryRouter);
storeRouter.use("/inventory", storeInventoryRouter);
storeRouter.use("/parameter", storeParameterRouter);

// Export Router
export default storeRouter;
