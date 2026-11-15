// Store reviews (Stage 7.5, L.7): any member of the store and platform admins. Members reply and
// report; they can't edit or remove reviews (only platform admins remove, via a report).
import { Router } from "express";
import route_list from "./list/index";
import route_reply from "./reply/index";
import route_report from "./report/index";

const storeReviewsRouter: Router = Router();

route_list(storeReviewsRouter);
route_reply(storeReviewsRouter);
route_report(storeReviewsRouter);

export default storeReviewsRouter;
