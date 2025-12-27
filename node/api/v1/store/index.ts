// Imports
import { Router } from "express";
import dotenv from "dotenv";
import storeInventoryRouter from "./inventory";
import storeCategoryRouter from "./category";
dotenv.config();

// User Router
const storeRouter: Router = Router();

// Routes
require("./create/index")(storeRouter);
require("./delete/index")(storeRouter);
require("./get-image-upload-url/index")(storeRouter);
require("./update-settings/index")(storeRouter);

// Paths
storeRouter.use("/category", storeCategoryRouter);
storeRouter.use("/inventory", storeInventoryRouter);

// Export Router
export default storeRouter;
