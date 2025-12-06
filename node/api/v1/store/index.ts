// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
dotenv.config();

// User Router
const router: Router = Router();

// Routes
require('./create/index')(router);
require('./delete/index')(router);
require('./suspend/index')(router);
require('./update/index')(router);

// Export Router
export default router;
