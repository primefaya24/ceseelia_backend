// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
dotenv.config();
import adminRoutes from './admin/index';
import userRoutes from './user/index';

// Api Router
const apiRouter: Router = Router();

// Routes
apiRouter.use("/admin", adminRoutes);
apiRouter.use("/user", userRoutes);

// Export Router
export default apiRouter;
