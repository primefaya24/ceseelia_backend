// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
import route_create from './create/index';
import route_delete from './delete/index';
import route_get_banner_upload_url from './get-banner-upload-url/index';
dotenv.config();

// User Router
const storeCategoryRouter: Router = Router();

// Routes
route_create(storeCategoryRouter);
route_delete(storeCategoryRouter);
route_get_banner_upload_url(storeCategoryRouter);
// Export Router
export default storeCategoryRouter;
