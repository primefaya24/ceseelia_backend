import {
    SES,
    SESClient,
    SendEmailCommand,
    SendEmailCommandInput,
    SendEmailCommandOutput,
    SendRawEmailCommand,
} from "@aws-sdk/client-ses";
import {appConstants} from "../../../constants";
import {wooInvoiceEmail} from "./templates";
const nodemailer = require('nodemailer');

// Create SES client
const sesClient = new SESClient({ region: "us-east-1" });
const ses = new SES({
    apiVersion: "2010-12-01",
    region: appConstants.DEFAULT_REGION,
});

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

/*
 * Send WooCommerce invoice email with optional PDF attachment
 */
interface WooInvoiceEmailParams {
    toEmailAddress: string;
    subject: string;
    header: string;
    message: string;
    invoiceRecord: any; // Replace with specific type if available
    invoicePdf?: Buffer | string;
    businessLocale: string;
}

export async function sendWooInvoiceEmail({
                                              toEmailAddress,
                                              subject,
                                              header,
                                              message,
                                              invoiceRecord,
                                              invoicePdf,
                                              businessLocale,
                                          }: WooInvoiceEmailParams): Promise<void> {
    try {
        const transporter = nodemailer.createTransport({
            SES: {
                ses,
                aws: { SendRawEmailCommand },
            },
        });

        await transporter.sendMail({
            from: `Diner's Xpress <${appConstants.SES_DEFAULT_FROM_ADDRESS}>`,
            to: [toEmailAddress],
            subject: subject,
            html: wooInvoiceEmail(
                header,
                message,
                invoiceRecord,
                businessLocale
            ),
            attachments: invoicePdf
                ? [
                    {
                        filename: "invoice.pdf",
                        content: invoicePdf,
                        encoding: "base64",
                    },
                ]
                : [],
        });
    } catch (error) {
        console.error("In sendWooInvoiceEmail:", error);
        throw error;
    }
}
