import {getObject, putObject} from "../../../aws/s3";

const PDFDocument = require('pdfkit');
import { PassThrough } from 'stream';
import {isNumeric} from "../index";
import {appConstants} from "../../../../constants";
import {STAGE} from "../../../../config";

// Constants
const TABLE_MT = 315;
const TABLE_HEADER_HEIGHT = 20;
const TABLE_ROW_HEIGHT = 30;

// You can replace `any` with a more specific type (e.g., Buffer, string, etc.) depending on the logo's format
let companyLogo: any;

async function createInvoicePdf(invoiceData: any): Promise<any> {
    try {
        return new Promise(async (resolve, reject) => {
            const doc = new PDFDocument({ size: "A4", margin: 50 });
            const stream = new PassThrough();
            const chunks: any = [];
            doc.pipe(stream);

            // Add content to PDF
            if (!companyLogo) {
                await fetchCompanyLogo();
            }
            generateInvoiceTable(doc, invoiceData);
            doc.end();

            // Collect data from stream
            stream.on("data", (chunk: any) => chunks.push(chunk));
            stream.on("end", () => resolve(Buffer.concat(chunks)));
            stream.on("error", reject);
        });
    } catch (err) {
        console.error("In createInvoicePdf", err)
        return null;
    }
}

async function fetchCompanyLogo(): Promise<any> {
    companyLogo = await getObject(appConstants.PUBLIC_STORAGE_BUCKET, "company_logo.png", "Buffer");
}

function generateHeader(doc: any, invoiceInfo: any, invoiceBusinessInfo: any): void {
    try {
        doc
            .image(companyLogo, 50, 45, { width: 150 })
            .fillColor("#444444")
            .fontSize(10)
            .text("Primefaya Computer Services", 390, 50, { align: "left" })
            .text("P.O Box 2232", 390, 65, { align: "left" })
            .text("Unity, SK S0K 4L0", 390, 80, { align: "left" })
            .text("Canada", 390, 95, { align: "left" })
            .moveDown();
        generateCustomerInformation(
            doc,
            invoiceInfo,
            invoiceBusinessInfo,
        );
    } catch (err) {
        console.error(" in generateHeader. Error: ", err)
        throw err
    }
}


function generateCustomerInformation(doc: any, invoice: any, client: any): void {
    try {
        doc
            .fillColor("#444444")
            .fontSize(20)
            .text("Invoice", 50, 130);

        generateHr(doc, 155);

        const billingPeriodArr = invoice.billingPeriod.split(" to ");
        const billingPeriodFromArr = billingPeriodArr[0].split("-");
        const billingPeriodToArr = billingPeriodArr[1].split("-");
        const billingPeriodFinal = `${billingPeriodFromArr[2]}/${billingPeriodFromArr[1]}/${billingPeriodFromArr[0]} - ${billingPeriodToArr[2]}/${billingPeriodToArr[1]}/${billingPeriodToArr[0]}`;

        const customerInformationTop = 170;
        doc
            .fontSize(10)
            .text("Invoice Number:", 50, customerInformationTop)
            .font("Helvetica-Bold")
            .text(invoice.invoiceNumber, 150, customerInformationTop)
            .font("Helvetica")

            .text("Billing Period:", 50, customerInformationTop + 15)
            .text(billingPeriodFinal, 150, customerInformationTop + 15)

            .text("Invoice Date:", 50, customerInformationTop + 30)
            .text(invoice.invoiceDate, 150, customerInformationTop + 30)

            .text("Payment Due Date:", 50, customerInformationTop + 45)
            .text(invoice.amountDueDate, 150, customerInformationTop + 45)

            // .text("Total Due:", 50, customerInformationTop + 45)
            // .text(
            //     formatCurrency(invoice.amountDue),
            //     150,
            //     customerInformationTop + 45
            // )

            .font("Helvetica-Bold")
            .text(client.businessName, 300, customerInformationTop)
            .font("Helvetica")
            .text(client.streetAddress, 300, customerInformationTop + 15)
            .text(
                `${client.city} ${client.postalCode} ${client.state}`,
                300,
                customerInformationTop + 30
            )
            .text(
                client.country,
                300,
                customerInformationTop + 45
            )
            .moveDown();
        generateHr(doc, TABLE_MT - 78);
    } catch (err) {
        console.error(" in generateCustomerInformation. Error: ", err)
        throw err
    }
}

function generateInvoiceTableHeader(doc: any): number  {
    try {
        doc
            .fillColor("#444444")
            .fontSize(20)
            .text("Invoice Details", 50, TABLE_MT - 45);
        generateHr(doc, TABLE_MT - 20);
        doc.font("Helvetica-Bold");
        generateTableRow(
            doc,
            TABLE_MT,
            "Date",
            "Description",
            "Amount",
            "Fee",
            "Total Fees"
        );
        generateHr(doc, TABLE_MT + TABLE_HEADER_HEIGHT);
        return TABLE_MT + TABLE_HEADER_HEIGHT;
    } catch (err) {
        console.error(" in generateInvoiceTableHeader. Error: ", err)
        throw err
    }
}

function generateInvoiceTable(doc: any, invoiceData: any): void {
    try {
        const itemPages = invoiceData.invoiceItemPages;
        let position = TABLE_MT;
        let totalAmount = 0;
        for (let p = 0; p < itemPages.length; p++) {
            generateHeader(doc, invoiceData.invoiceInfo, invoiceData.invoiceBusinessInfo);
            position = TABLE_MT;
            generateInvoiceTableHeader(doc);
            doc.font("Helvetica");
            for (let i = 0; i < itemPages[p].length; i++) {
                const item = itemPages[p][i];
                position += TABLE_ROW_HEIGHT;
                generateTableRow(
                    doc,
                    position,
                    item.date,
                    item.description,
                    isNumeric(item.orderAmount) ? formatCurrency(Number(item.orderAmount)) : "",
                    formatCurrency(Number(item.fee)),
                    item.total
                );
                generateHr(doc, position + 20);
                totalAmount += Number(item.fee);
            }
            generateFooter(doc, `Page ${p + 1} of ${itemPages.length}`);
            if (p < itemPages.length - 1) {
                doc.addPage();
            }
        }
        generateInvoiceTableBottom(doc, position + TABLE_ROW_HEIGHT, totalAmount);
    } catch (err) {
        console.error(" in generateInvoiceTable. Error: ", err)
        throw err
    }
}

function generateInvoiceTableBottom(doc: any, subtotalPosition: any, totalAmount: any): void {
    try {
        let tableGap = 0;
        doc.font("Helvetica-Bold");
        generateTableRow(
            doc,
            subtotalPosition + tableGap,
            "",
            "",
            "",
            "Total Due",
            formatCurrency(totalAmount >= 0 ? totalAmount : 0)
        );
    } catch (err) {
        console.error(" in generateInvoiceTableBottom. Error: ", err)
        throw err
    }
}

function generateFooter(doc: any, text: any): void {
    try {
        doc.font("Helvetica");
        doc
            .fontSize(10)
            .text(
                text,
                50,
                780,
                { align: "center", width: 500 }
            );
    } catch (err) {
        console.error(" in generateFooter. Error: ", err)
        throw err
    }
}

function generateTableRow(
    doc: any,
    y: any,
    date: any,
    description: any,
    orderAmount: any,
    fee: any,
    total: any
): void {
    doc
        .fontSize(10)
        .text(date, 50, y)
        .text(description, 125, y)
        .text(orderAmount, 317, y, { width: 70, align: "right" })
        .text(fee, 415, y, { width: 40, align: "right" })
        .text(total, 0, y, { align: "right" });
}

function generateHr(doc: any, y: any): void {
    doc
        .strokeColor("#aaaaaa")
        .lineWidth(1)
        .moveTo(50, y)
        .lineTo(550, y)
        .stroke();
}

function formatCurrency(cents: number): string {
    return "$" + (cents / 100).toFixed(2);
}

function formatDate(date: any): string {
    const day = date.getDate();
    const month = date.getMonth() + 1;
    const year = date.getFullYear();
    return year + "/" + month + "/" + day;
}

export async function generateInvoice(websiteId: any, invoiceId: any, invoiceData: any): Promise<any> {
    try {
        const pdfBuffer = await createInvoicePdf(invoiceData);
        await putObject(appConstants.S3_STORAGE_BUCKET_PREFIX + STAGE, `website/${websiteId}/${appConstants.S3_FOLDER_ONLINE_ORDERING_INVOICES}/${invoiceId}.pdf`, "application/pdf", pdfBuffer);
    } catch (err) {
        console.error("In generateInvoice", err)
        return null;
    }
}