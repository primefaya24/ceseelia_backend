import {QueueItem} from "./dqs";
import {appConstants} from "../../../../constants";
import {cleanUpWebsiteMedia} from "./clean-up-website-media";
import {wooNotifyTeamMembers} from "./woo-notify-team-members";
import {wooNotifyCustomerOrderReady} from "./woo-notify-customer-order-ready";
import {wooHandleStripeEvent} from "./woo-handle-stripe-event";
import {wooNotifyCustomerPaymentLink} from "./woo-notify-customer-payment-link";

export async function dqsHandler(item: QueueItem): Promise<void> {
    switch (item.topicId) {
        case appConstants.SQS_MESSAGE_TOPIC_ID_CLEAN_UP_WEBSITE_UN_USED_MEDIA:
            await cleanUpWebsiteMedia(item.data.websiteId)
            break;
        case appConstants.SQS_MESSAGE_TOPIC_ID_WOO_NOTIFY_TEAM_MEMBERS:
            await wooNotifyTeamMembers(item.data.websiteId, item.data.notificationType, item.data.title, item.data.body);
            break;
        case appConstants.SQS_MESSAGE_TOPIC_ID_WOO_NOTIFY_CUSTOMER_ORDER_READY:
            await wooNotifyCustomerOrderReady(item.data.websiteId, item.data.orderId);
            break;
        case appConstants.SQS_MESSAGE_TOPIC_ID_WOO_NOTIFY_CUSTOMER_PAYMENT_LINK:
            await wooNotifyCustomerPaymentLink(item.data.websiteInfo, item.data.onlineOrder, item.data.paymentLink);
            break
        case appConstants.SQS_MESSAGE_TOPIC_ID_WOO_HANDLE_STRIPE_EVENT:
            await wooHandleStripeEvent(item.data.req, item.data.res);
            break;
        default:
            console.error("In dqs: dqsHandler", "topic id not identified", item.topicId);
            break;
    }
}