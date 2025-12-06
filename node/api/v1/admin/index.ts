// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
dotenv.config();

// User Router
const adminRouter: Router = Router();

// Routes
require('./get-overview-data/index')(adminRouter);
require('./update-store-info/index')(adminRouter);

// Export Router
export default adminRouter;
