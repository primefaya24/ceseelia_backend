import { SNSClient, PublishCommand, PublishCommandInput, PublishCommandOutput } from "@aws-sdk/client-sns";
import {appConstants} from "../../../constants";

// Initialize the SNS client
const snsClient: SNSClient = new SNSClient({
    region: appConstants.DEFAULT_REGION,
});

/**
 * Send an SMS message using AWS SNS
 */
export async function sendSMS(
    originatorID: string,
    toNumber: string,
    message: string
): Promise<PublishCommandOutput | void> {
    try {
        const isValidPhone = /^\+?[1-9]\d{1,14}$/.test(originatorID);
        if (!isValidPhone) {
            console.error("Invalid originatorID. Must be a valid phone number.");
            return;
        }

        const params: PublishCommandInput = {
            Message: message,
            PhoneNumber: toNumber,
            MessageAttributes: {
                SenderID: {
                    DataType: "String",
                    StringValue: appConstants.SNS_SENDER_ID,
                },
                OriginationNumber: {
                    DataType: "String",
                    StringValue: originatorID,
                },
            },
        };

        return await snsClient.send(new PublishCommand(params));
    } catch (e) {
        console.error("In sendSMS", e);
        return;
    }
}
