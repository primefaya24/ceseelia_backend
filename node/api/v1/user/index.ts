// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
dotenv.config();

// User Router
const userRouter: Router = Router();

// Routes
require('./get-my-profile/index')(userRouter);
require('./update-fcm-token/index')(userRouter);
require('./update-profile/index')(userRouter);
require('./delete-user/index')(userRouter);

// Export Router
export default userRouter;
