import {
    SESClient,
    SendEmailCommand,
    SendRawEmailCommand,
    SendEmailCommandInput,
    SendEmailCommandOutput,
} from "@aws-sdk/client-ses";
import {appConstants} from "../../../constants";
import { log } from "../../core/logger";

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
        log.error({ err: error }, "Error in createSendEmailCommand");
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
        log.error({ err: error }, "In sendEmail");
        if (failStrict) throw error;
    }
}

/* A header value with no line breaks, MIME-encoded when it isn't plain ASCII. */
const headerText = (v: string): string => {
    const clean = v.replace(/[\r\n]+/g, " ").trim();
    return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
};
const base64Lines = (b: Buffer): string => (b.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");

export interface EmailAttachment {
    filename: string;
    contentType: string;
    content: Buffer;
}

/*
 * An HTML email with attachments (6.5: the PDF receipt), as a raw MIME message. Same rules as
 * sendEmail: our From address, an optional Reply-To, errors logged (thrown with failStrict).
 */
export function buildRawEmail(opts: {
    subject: string;
    fromName: string;
    fromAddress: string;
    to: string;
    html: string;
    replyTo?: string;
    attachments: EmailAttachment[];
    boundary?: string;
}): string {
    const boundary = opts.boundary ?? `ceseelia-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const addr = (a: string) => a.replace(/[\r\n<>,;"]/g, "").trim();
    const headers = [
        `From: ${senderName(opts.fromName)} <${addr(opts.fromAddress)}>`,
        `To: ${addr(opts.to)}`,
        ...(opts.replyTo ? [`Reply-To: ${addr(opts.replyTo)}`] : []),
        `Subject: ${headerText(opts.subject)}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ];
    const parts = [
        [
            `--${boundary}`,
            'Content-Type: text/html; charset="UTF-8"',
            "Content-Transfer-Encoding: base64",
            "",
            base64Lines(Buffer.from(opts.html, "utf8")),
        ].join("\r\n"),
        ...opts.attachments.map((a) => {
            const name = a.filename.replace(/["\r\n\\/]/g, "_");
            return [
                `--${boundary}`,
                `Content-Type: ${a.contentType}; name="${name}"`,
                "Content-Transfer-Encoding: base64",
                `Content-Disposition: attachment; filename="${name}"`,
                "",
                base64Lines(a.content),
            ].join("\r\n");
        }),
    ];
    return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n--${boundary}--\r\n`;
}

export async function sendEmailWithAttachments(
    subject: string,
    outerSubject: string,
    toAddress: string,
    htmlBody: string,
    attachments: EmailAttachment[],
    replyTo?: string,
    failStrict = false
): Promise<{ MessageId?: string } | void> {
    try {
        const raw = buildRawEmail({
            subject,
            fromName: outerSubject,
            fromAddress: appConstants.SES_DEFAULT_FROM_ADDRESS,
            to: toAddress,
            html: htmlBody,
            replyTo,
            attachments,
        });
        return await sesClient.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(raw, "utf8") } }));
    } catch (error) {
        log.error({ err: error }, "In sendEmailWithAttachments");
        if (failStrict) throw error;
    }
}
