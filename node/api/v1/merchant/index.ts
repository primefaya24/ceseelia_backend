// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
import route_get_overview_data from './get-overview-data/index';
dotenv.config();

// User Router
const merchantRouter: Router = Router();

// Routes
route_get_overview_data(merchantRouter);
// Export Router
export default merchantRouter;
