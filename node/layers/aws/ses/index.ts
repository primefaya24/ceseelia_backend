import {
    SESClient,
    SendEmailCommand,
    SendEmailCommandInput,
    SendEmailCommandOutput,
} from "@aws-sdk/client-ses";
import {appConstants} from "../../../constants";

/*
 * The From name: header-safe (no quotes, brackets, commas or line breaks, at most 70 chars), and
 * MIME-encoded when it isn't plain ASCII (store names like "Café Lune"), as SES requires.
 */
export function senderName(name: string): string {
    const clean = name.replace(/[\r\n"<>,;\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 70) || "Ceseelia";
    return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

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
    htmlBody: string,
    replyTo?: string
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
            Source: `${senderName(outerSubject)} <${fromAddress}>`,
            // Replies go here; the From address is always ours (never a customer's, 3.4)
            ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
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
    failStrict = false,
    replyTo?: string
): Promise<SendEmailCommandOutput | void> {
    try {
        const command = createSendEmailCommand(
            subject,
            outerSubject,
            appConstants.SES_DEFAULT_FROM_ADDRESS,
            toAddress,
            htmlBody,
            replyTo
        );
        return await sesClient.send(command);
    } catch (error) {
        console.error("In sendEmail:", error);
        if (failStrict) throw error;
    }
}
