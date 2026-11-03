// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
import route_get_my_profile from './get-my-profile/index';
import route_update_fcm_token from './update-fcm-token/index';
import route_update_profile from './update-profile/index';
import route_delete_user from './delete-user/index';
dotenv.config();

// User Router
const userRouter: Router = Router();

// Routes
route_get_my_profile(userRouter);
route_update_fcm_token(userRouter);
route_update_profile(userRouter);
route_delete_user(userRouter);
// Export Router
export default userRouter;
