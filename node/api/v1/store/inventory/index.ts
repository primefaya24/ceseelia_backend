// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
dotenv.config();

// User Router
const storeInventoryRouter: Router = Router();

// Routes
require("./create-item/index")(storeInventoryRouter);
require("./get-data/index")(storeInventoryRouter);

// Export Router
export default storeInventoryRouter;
