// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
dotenv.config();
import adminRouter from './admin/index';
import customerRouter from './customer/index';
import merchantRouter from './merchant/index';
import storeRouter from './store/index';
import userRouter from './user/index';

// Api Router
const apiRouter: Router = Router();

// Routes
apiRouter.use("/admin", adminRouter);
apiRouter.use("/customer", customerRouter);
apiRouter.use("/merchant", merchantRouter);
apiRouter.use("/store", storeRouter);
apiRouter.use("/user", userRouter);

// Export Router
export default apiRouter;
