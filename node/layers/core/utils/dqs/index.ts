import { appConstants } from "../../../../constants";
import {QueueItem} from "./dqs";
import { handleStripeEvent } from "./woo-handle-stripe-event";
import { log } from "../../logger";

export async function dqsHandler(item: QueueItem): Promise<void> {
    switch (item.topicId) {
        case appConstants.SQS_MESSAGE_TOPIC_ID_WOO_HANDLE_STRIPE_EVENT:
            await handleStripeEvent(item.data.req, item.data.res);
            break;
        default:
            log.error({ topicId: item.topicId }, "In dqs: dqsHandler: topic id not identified");
            break;
    }
}