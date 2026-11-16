// Store ↔ shopper messages (progress.md L.10): any member of the store, and platform admins
// (who read reported conversations here; reading never marks anything read: that's POST /read).
import { Router } from "express";
import route_list from "./list/index";
import route_unread from "./unread/index";
import route_thread from "./thread/index";
import route_send from "./send/index";
import route_read from "./read/index";
import route_image_upload_urls from "./image-upload-urls/index";
import route_report from "./report/index";

const storeMessagesRouter: Router = Router();

route_list(storeMessagesRouter);
route_unread(storeMessagesRouter);
route_thread(storeMessagesRouter);
route_send(storeMessagesRouter);
route_read(storeMessagesRouter);
route_image_upload_urls(storeMessagesRouter);
route_report(storeMessagesRouter);

export default storeMessagesRouter;
