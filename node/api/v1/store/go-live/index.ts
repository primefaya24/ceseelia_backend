// Go Live routes (progress.md P.4): the checklist and the Go Live action
import { Router } from "express";
import route_checklist from "./checklist/index";
import route_go_live from "./go-live/index";

const storeGoLiveRouter: Router = Router();

route_checklist(storeGoLiveRouter);
route_go_live(storeGoLiveRouter);

export default storeGoLiveRouter;
