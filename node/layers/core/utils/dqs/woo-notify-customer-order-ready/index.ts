import {appConstants} from "../../../../../constants";
import {getWebsiteInfo, getWebsiteOnlineOrder} from "../../../../aws/dynamodb/dynamo-entities/website";
import {sendSMS} from "../../../../aws/sns";
import {IN_DEV} from "../../../../../config";

export function determineOriginationId(websiteBusinessLocale: string): string {
    let originationId;
    switch (websiteBusinessLocale) {
        case appConstants.BUSINESS_LOCALE_CA:
            originationId = appConstants.SNS_ORIGINATOR_ID_CA;
            break;
        case appConstants.BUSINESS_LOCALE_US:
            originationId = ""; // env.SNS_ORIGINATOR_ID_US;
            break;
        default:
            originationId = "";
            break;
    }
    return originationId;
}

export async function wooNotifyCustomerOrderReady(websiteId: string, orderId: string): Promise<void> {
    try {
        const websiteInfo: any = await getWebsiteInfo(websiteId);
        const onlineOrder: any = await getWebsiteOnlineOrder(websiteId, orderId);
        const originationId: string = determineOriginationId(websiteInfo.websiteBusinessLocale);
        if (originationId.length === 0) {
            console.error(`Business locale (${websiteInfo.websiteBusinessLocale}) not supported`);
            return;
        }
        if (onlineOrder && onlineOrder.orderCustomerPhoneNumberNotification?.value) {
            const message: string = onlineOrder.orderType === appConstants.ONLINE_ORDER_TYPE_PICKUP
                ? `[${websiteInfo.websiteBusinessName}] Your order is ready for pickup`
                : `[${websiteInfo.websiteBusinessName}] Your order is on the way`;
            if (IN_DEV) {
                console.warn("Simulating Order Ready SMS: ", message);
                return;
            }
            await sendSMS(
                originationId,
                onlineOrder.orderCustomerPhoneNumber,
                message
            );
        }
    }
    catch (err) {
        console.error("In dqs: wooNotifyCustomerOrderReady", err);
    }
}