// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
dotenv.config();

// User Router
const storeParameterRouter: Router = Router();

// Routes
require("./create/index")(storeParameterRouter);
require("./delete/index")(storeParameterRouter);

// Export Router
export default storeParameterRouter;
