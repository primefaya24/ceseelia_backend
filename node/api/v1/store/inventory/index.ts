// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
import route_create_item from './create-item/index';
import route_delete_item from './delete-item/index';
import route_get_data from './get-data/index';
import route_get_data_public from './get-data-public/index';
import route_get_item_image_upload_urls from './get-item-image-upload-urls/index';
dotenv.config();

// User Router
const storeInventoryRouter: Router = Router();

// Routes
route_create_item(storeInventoryRouter);
route_delete_item(storeInventoryRouter);
route_get_data(storeInventoryRouter);
route_get_data_public(storeInventoryRouter);
route_get_item_image_upload_urls(storeInventoryRouter);
// Export Router
export default storeInventoryRouter;
