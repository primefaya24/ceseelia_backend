import {
    SESClient,
    SendEmailCommand,
    SendEmailCommandInput,
    SendEmailCommandOutput,
} from "@aws-sdk/client-ses";
import {appConstants} from "../../../constants";

// Create SES client
const sesClient = new SESClient({ region: "us-east-1" });

/*
 * Create email params
 */
function createSendEmailCommand(
    subject: string,
    outerSubject: string,
    fromAddress: string,
    toAddress: string,
    htmlBody: string
): SendEmailCommand {
    try {
        const params: SendEmailCommandInput = {
            Destination: {
                ToAddresses: [toAddress],
            },
            Message: {
                Body: {
                    Html: {
                        Charset: "UTF-8",
                        Data: htmlBody,
                    },
                },
                Subject: {
                    Charset: "UTF-8",
                    Data: subject,
                },
            },
            Source: `${outerSubject} <${fromAddress}>`,
        };

        return new SendEmailCommand(params);
    } catch (error) {
        console.error("Error in createSendEmailCommand:", error);
        throw error;
    }
}

/*
 * Send email using SES
 */
export async function sendEmail(
    subject: string,
    outerSubject: string,
    toAddress: string,
    htmlBody: string,
    failStrict = false
): Promise<SendEmailCommandOutput | void> {
    try {
        const command = createSendEmailCommand(
            subject,
            outerSubject,
            appConstants.SES_DEFAULT_FROM_ADDRESS,
            toAddress,
            htmlBody
        );
        return await sesClient.send(command);
    } catch (error) {
        console.error("In sendEmail:", error);
        if (failStrict) throw error;
    }
}
