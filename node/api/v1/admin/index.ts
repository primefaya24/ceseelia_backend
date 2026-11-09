// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
import route_get_all_stores from './get-all-stores/index';
import route_get_overview_data from './get-overview-data/index';
import route_update_store_info from './update-store-info/index';
import route_get_store_members from './get-store-members/index';
import route_assign_store_member from './assign-store-member/index';
import route_remove_store_member from './remove-store-member/index';
import route_cancel_store_invite from './cancel-store-invite/index';
import route_get_store_admin_settings from './get-store-admin-settings/index';
import route_update_store_admin_settings from './update-store-admin-settings/index';
dotenv.config();

// User Router
const adminRouter: Router = Router();

// Routes
route_get_all_stores(adminRouter);
route_get_overview_data(adminRouter);
route_update_store_info(adminRouter);
route_get_store_members(adminRouter);
route_assign_store_member(adminRouter);
route_remove_store_member(adminRouter);
route_cancel_store_invite(adminRouter);
route_get_store_admin_settings(adminRouter);
route_update_store_admin_settings(adminRouter);
// Export Router
export default adminRouter;
