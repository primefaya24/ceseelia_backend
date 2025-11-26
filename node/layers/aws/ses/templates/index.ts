import {getPaymentLink} from "../../../core/utils";
import {appConstants} from "../../../../constants";

export function wooInvoiceEmail(header: any, message: any, invoiceRecord: any, businessLocale: any): string {
    return `<!DOCTYPE html>` +
        `<html>` +
        `    <body style="margin: 0 !important; padding: 0 !important;">` +
        `        <div style='width: 100%; padding: 0;'>` +
        `            <div style="max-width: 370px; text-align: center; background-color: transparent; margin: 0 auto;">` +
        `                <div style="white-space: pre-line; margin-top:20px;">` +
        `                    ${header} ` +
        `                </div>` +
        `                <div style="margin-top: 25px; color: #000000;">` +
        `                    ${message}` +
        `                </div>` +
        `                <div style="margin-top: 25px; color: #000000;">` +
        `                    <div style="font-size: 21px; font-weight: bold; margin-bottom: 5px">` +
        `                       Invoice Information ` +
        `                    </div>` +
        `                    <span style="font-weight: bold;">Invoice #:</span> ${invoiceRecord.invoiceInfo.invoiceNumber} <br>` +
        `                    <span style="font-weight: bold;">Billing Period:</span> ${invoiceRecord.invoiceInfo.billingPeriod} <br>` +
        `                    <span style="font-weight: bold;">Amount Due:</span> \$${(invoiceRecord.invoiceInfo.amountDue / 100).toFixed(2)} <br>` +
        `                    <span style="font-weight: bold;">Date Due:</span> ${invoiceRecord.invoiceInfo.amountDueDate.replaceAll("-", "/")} <br>` +
        `                </div>` +
        `                <div style="text-align: center; margin-top: 25px;">` +
        `                    <a href="${getPaymentLink(businessLocale)}" target="_blank">` +
        `                        <div style="display: inline-block; width: 180px; margin: 0 auto; font-weight: bold; font-size: 14px; background-color: #e21f36; color: white; padding: 8px 12px; text-decoration: none !important;">Pay Invoice</div>` +
        `                    </a>` +
        `                </div>` +
        `                <div style="margin-top: 25px; color: #000000;">` +
        `                    We appreciate your continued partnership. <br>` +
        `                    If you have any questions, feel free to reach out.` +
        `                </div>` +
        `                <div style="margin-top: 25px; color: #000000;">` +
        `                    Best Regards, <br>` +
        `                    <div style="height: ${appConstants.COMPANY_LOGO_HEIGHT}px; width: ${appConstants.COMPANY_LOGO_WIDTH}px; margin: 15px auto 0 auto; background-repeat: no-repeat; background-size: cover; background-image: url('${appConstants.COMPANY_LOGO_COMPACT_URL}')"></div>` +
        `                </div>` +
        `            </div>` +
        `        </div>` +
        `    </body>` +
        `</html>`;
}