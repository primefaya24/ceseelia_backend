// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
dotenv.config();

// User Router
const router: Router = Router();

// Routes
require('./get-overview-data/index')(router);

// Export Router
export default router;
