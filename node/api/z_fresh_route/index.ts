// Template router: copy this folder when adding a new area.
// Each endpoint lives in its own folder exporting `export default function registerRoute(router)`.
import {Router} from 'express';
import route_function from './function';

const router: Router = Router();

route_function(router);

export default router;
