// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
import route_get_my_profile from './get-my-profile/index';
import route_update_fcm_token from './update-fcm-token/index';
import route_update_profile from './update-profile/index';
import route_delete_user from './delete-user/index';
import route_push_config from './push/config/index';
import route_push_subscribe from './push/subscribe/index';
import route_push_unsubscribe from './push/unsubscribe/index';
import route_push_test from './push/test/index';
dotenv.config();

// User Router
const userRouter: Router = Router();

// Routes
route_get_my_profile(userRouter);
route_update_fcm_token(userRouter);
route_update_profile(userRouter);
route_delete_user(userRouter);
// L.5 web push
route_push_config(userRouter);
route_push_subscribe(userRouter);
route_push_unsubscribe(userRouter);
route_push_test(userRouter);
// Export Router
export default userRouter;
