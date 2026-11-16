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
import route_get_review_queue from './get-review-queue/index';
import route_review_store from './review-store/index';
import route_set_store_plan from './set-store-plan/index';
import route_get_item_review_queue from './get-item-review-queue/index';
import route_review_item from './review-item/index';
import route_get_review_reports from './get-review-reports/index';
import route_decide_review_report from './decide-review-report/index';
import route_support from './support/index';
import route_commission_report from './commission-report/index';
import route_queue_counts from './queue-counts/index';
import route_get_message_reports from './get-message-reports/index';
import route_decide_message_report from './decide-message-report/index';
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
route_get_review_queue(adminRouter);
route_review_store(adminRouter);
route_set_store_plan(adminRouter);
route_get_item_review_queue(adminRouter);
route_review_item(adminRouter);
route_get_review_reports(adminRouter);
route_decide_review_report(adminRouter);
route_support(adminRouter);
route_commission_report(adminRouter);
route_queue_counts(adminRouter);
route_get_message_reports(adminRouter); // L.10
route_decide_message_report(adminRouter);
// Export Router
export default adminRouter;
