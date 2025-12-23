// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
dotenv.config();

// User Router
const merchantRouter: Router = Router();

// Routes
require('./get-overview-data/index')(merchantRouter);

// Export Router
export default merchantRouter;
