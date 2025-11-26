import {sendSMS} from "../../../../aws/sns";
import {IN_DEV} from "../../../../../config";
import {determineOriginationId} from "../woo-notify-customer-order-ready";

export async function wooNotifyCustomerPaymentLink(websiteInfo: any, onlineOrder: any, paymentLink: string): Promise<void> {
    try {
        const originationId: string = determineOriginationId(websiteInfo.websiteBusinessLocale);
        if (originationId.length === 0) {
            console.error(`Business locale (${websiteInfo.websiteBusinessLocale}) not supported`);
            return;
        }
        if (onlineOrder) {
            const message: string = `[${websiteInfo.websiteBusinessName}] Please use this link to complete your order payment: ${paymentLink}`;
            if (IN_DEV) {
                console.warn("Simulating Payment Link SMS: ", message);
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
        console.error("In dqs: wooNotifyCustomerPaymentLink", err);
    }
}