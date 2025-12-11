// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
dotenv.config();

// User Router
const storeCategoryRouter: Router = Router();

// Routes
require("./create/index")(storeCategoryRouter);
require("./delete/index")(storeCategoryRouter);
require("./update/index")(storeCategoryRouter);

// Export Router
export default storeCategoryRouter;
