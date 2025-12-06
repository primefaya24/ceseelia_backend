// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
dotenv.config();
import adminRoutes from './admin/index';
import userRoutes from './user/index';
import merchantRoutes from './merchant/index';
import storeRoutes from './store/index';

// Api Router
const apiRouter: Router = Router();

// Routes
apiRouter.use("/admin", adminRoutes);
apiRouter.use("/user", userRoutes);
apiRouter.use("/merchant", merchantRoutes);
apiRouter.use("/store", storeRoutes);

// Export Router
export default apiRouter;
