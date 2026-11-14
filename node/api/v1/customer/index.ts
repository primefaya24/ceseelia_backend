// Imports
import {Router} from 'express';
import dotenv from 'dotenv';
dotenv.config();

// User Router
const customerRouter: Router = Router();

// Routes
import route_contact_store from './contact-store/index';
route_contact_store(customerRouter);
import route_quote from './quote/index';
route_quote(customerRouter);
import route_create_order from './create-order/index';
route_create_order(customerRouter);

// Export Router
export default customerRouter;
