// Imports
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    DynamoDBDocumentClient,
    QueryCommand,
    DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {appConstants} from "../../../../../../constants";
import {STAGE} from "../../../../../../config";
import {dynamoWriteManyItems} from "../../../dynamo-batch-ops";
import {
    createWebsiteInvoiceRecord,
    getWebsiteCompletedOnlineOrders,
    getWebsiteInfo,
    getWebsiteInvoiceRecord
} from "../index";
import {formatDateFromTimestamp, getDaysBetweenTimestamps, getLatLngTimezoneData, getUtcTimestamp} from "../../../../../core/utils";
import {generateInvoice} from "../../../../../core/utils/pdf";
import {getObjectBase64} from "../../../../s3";
import {sendWooInvoiceEmail} from "../../../../ses";

// Initialize DynamoDB Document Client
const dynamoDbDocumentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({
        region: appConstants.DEFAULT_REGION,
    })
);

// Constants
const DEFAULT_TABLE_NAME: string | undefined = `${appConstants.DYNAMO_TABLE_PREFIX}${STAGE}`;

////////////////////////////////////////
// Get Website Data Versions
////////////////////////////////////////
export async function getWebsiteDataVersions(
    websiteId: any,
) {
    try {
        let allWebsiteDataVersions: any[] = [];
        let lastEvaluatedKey;

        do {
            const command: QueryCommand = new QueryCommand({
                TableName: DEFAULT_TABLE_NAME,
                KeyConditionExpression: "#pk = :pk and begins_with(#sk, :sk_prefix)",
                ExpressionAttributeNames: {
                    "#pk": "pk",
                    "#sk": "sk"
                },
                ExpressionAttributeValues: {
                    ":pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                    ":sk_prefix": appConstants.DYNAMO_ENTITY_DATA + "#"
                },
                ScanIndexForward: false,
                Limit: appConstants.DATA_VERSIONS_LIMIT,
                ExclusiveStartKey: lastEvaluatedKey // for pagination
            });

            const result = await dynamoDbDocumentClient.send(command);
            allWebsiteDataVersions = allWebsiteDataVersions.concat(result.Items);

            // Update the lastEvaluatedKey to paginate if more data is available
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey); // Continue fetching data until there's no more

        // Clean records
        for (let websiteRecentDataVersion of allWebsiteDataVersions) {
            websiteRecentDataVersion["websiteId"] = websiteRecentDataVersion["pk"].split("#")[1];
            websiteRecentDataVersion["websiteDataCreatedAt"] = Number(websiteRecentDataVersion["sk"].split("#")[1]);
            websiteRecentDataVersion["websiteDataCreatorUserId"] = websiteRecentDataVersion["itemAncestor"].split("#")[1];
            delete websiteRecentDataVersion["pk"];
            delete websiteRecentDataVersion["sk"];
            delete websiteRecentDataVersion["itemAncestor"];
        }

        return allWebsiteDataVersions;
    } catch (e) {
        console.error("In getWebsiteDataVersions", e);
        throw "Could not getWebsiteDataVersions";
    }
}

////////////////////////////////////////
// Delete Website
////////////////////////////////////////
export async function deleteWebsite(
    websiteId: any,
    ) {
    try {
        // Build deletion array
        const itemsDeleteRequests = [
            // Website
            {
                DeleteRequest: {
                    Key: {
                        "pk": appConstants.DYNAMO_ENTITY_APP + "#" + appConstants.DYNAMO_ENTITY_WEBSITE,
                        "sk": appConstants.DYNAMO_ENTITY_INFO + "#" + websiteId,
                    }
                }
            },
        ];

        // All other records
        const allWebsiteRecords = await getAllWebsiteRecords(websiteId);
        for (let websiteRecordItem of allWebsiteRecords) {
            itemsDeleteRequests.push({
                DeleteRequest: {
                    Key: {
                        "pk": websiteRecordItem["pk"],
                        "sk": websiteRecordItem["sk"],
                    }
                }
            });
        }

        // Write batch
        await dynamoWriteManyItems(DEFAULT_TABLE_NAME, itemsDeleteRequests);
    } catch (e) {
        console.error("In deleteWebsite", e);
        throw "Could not deleteWebsite";
    }
}

////////////////////////////////////////
// Get all websites
////////////////////////////////////////
export async function getAllWebsites() {
    try {
        let allWebsites: any[] = [];
        let lastEvaluatedKey;

        do {
            const command: QueryCommand = new QueryCommand({
                TableName: DEFAULT_TABLE_NAME,
                KeyConditionExpression: '#pk = :pk',
                ExpressionAttributeNames: {
                    "#pk": "pk"
                },
                ExpressionAttributeValues: {
                    ":pk": appConstants.DYNAMO_ENTITY_APP + "#" + appConstants.DYNAMO_ENTITY_WEBSITE
                },
                ExclusiveStartKey: lastEvaluatedKey // for pagination
            });

            const result = await dynamoDbDocumentClient.send(command);
            allWebsites = allWebsites.concat(result.Items);

            // Update the lastEvaluatedKey to paginate if more data is available
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey); // Continue fetching data until there's no more

        // Clean results
        for (let website of allWebsites) {
            website["websiteId"] = website["sk"].split("#")[1];
            website["websiteCreatorUserId"] = website["itemAncestor"].split("#")[1];
            website["websiteMemberStatus"] = appConstants.DYNAMO_ENTITY_APPROVED;
            website["websiteMemberPermission"] = appConstants.USER_PERMISSION_ADMIN;
            delete website["pk"];
            delete website["sk"];
            delete website["itemAncestor"];
        }

        return allWebsites;
    } catch (e) {
        console.error("In getAllWebsites", e);
        throw "Could not getAllWebsites";
    }
}

////////////////////////////////////////
// Get all website records
////////////////////////////////////////
export async function getAllWebsiteRecords(
    websiteId: any,
    ) {
    try {
        let allWebsiteRecords: any[] = [];
        let lastEvaluatedKey;

        do {
            const command: QueryCommand= new QueryCommand({
                TableName: DEFAULT_TABLE_NAME,
                KeyConditionExpression: '#pk = :pk',
                ExpressionAttributeNames: {
                    "#pk": "pk"
                },
                ExpressionAttributeValues: {
                    ":pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId
                },
                ExclusiveStartKey: lastEvaluatedKey // for pagination
            });

            const result = await dynamoDbDocumentClient.send(command);
            allWebsiteRecords = allWebsiteRecords.concat(result.Items);

            // Update the lastEvaluatedKey to paginate if more data is available
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey); // Continue fetching data until there's no more

        return allWebsiteRecords;
    } catch (e) {
        console.error("In getAllWebsiteRecords", e);
        throw "Could not getAllWebsiteRecords";
    }
}

////////////////////////////////////////
// Get CF distributions to Delete
////////////////////////////////////////
export async function getCfDistributionsToDelete() {
    try {
        let allCfDistributions: any[] = [];
        let lastEvaluatedKey;

        do {
            const command: QueryCommand = new QueryCommand({
                TableName: DEFAULT_TABLE_NAME,
                KeyConditionExpression: '#pk = :pk',
                ExpressionAttributeNames: {
                    "#pk": "pk"
                },
                ExpressionAttributeValues: {
                    ":pk": appConstants.DYNAMO_ENTITY_APP + "#" + appConstants.DYNAMO_ENTITY_CFD_TO_DELETE
                },
                ExclusiveStartKey: lastEvaluatedKey // for pagination
            });

            const result = await dynamoDbDocumentClient.send(command);
            allCfDistributions = allCfDistributions.concat(result.Items);

            // Update the lastEvaluatedKey to paginate if more data is available
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey); // Continue fetching data until there's no more

        // Clean results
        for (let cfd of allCfDistributions) {
            cfd["distributionId"] = cfd["sk"];
            cfd["websiteId"] = cfd["cfDistributionToDeleteWebsiteId"];
            cfd["websiteDomain"] = cfd["cfDistributionToDeleteWebsiteDomain"];
            delete cfd["pk"];
            delete cfd["sk"];
            delete cfd["cfDistributionToDeleteWebsiteId"];
            delete cfd["cfDistributionToDeleteWebsiteDomain"];
        }

        return allCfDistributions;
    } catch (e) {
        console.error("In getCfDistributionsToDelete", e);
        throw "Could not getCfDistributionsToDelete";
    }
}

////////////////////////////////////////
// Delete CF distribution record to delete
////////////////////////////////////////
export async function deleteCfDistributionsToDelete(
    distributionId: any,
    ) {
    try {
        const command = new DeleteCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_APP + "#" + appConstants.DYNAMO_ENTITY_CFD_TO_DELETE,
                "sk": distributionId,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In deleteCfDistributionsToDelete", e);
        throw "Could not deleteCfDistributionsToDelete";
    }
}

////////////////////////////////////////
// Get Online Ordering Websites
////////////////////////////////////////
export async function getOnlineOrderingWebsites(
    lastEvaluatedKey: any = null,
    ) {
    try {
        const params: any = {
            TableName: DEFAULT_TABLE_NAME,
            IndexName: appConstants.INDEX_NAME_WEBSITE_REPORTING_GSI,
            KeyConditionExpression: '#pk = :pk',
            ExpressionAttributeNames: {
                "#pk": "pk",
            },
            ExpressionAttributeValues: {
                ":pk": appConstants.DYNAMO_ENTITY_APP + "#" + appConstants.DYNAMO_ENTITY_WEBSITE
            },
            Limit: 15,
            ScanIndexForward: false,
        };
        if (lastEvaluatedKey) {
            params["ExclusiveStartKey"] = lastEvaluatedKey;
        }
        const result = await dynamoDbDocumentClient.send(new QueryCommand(params));
        const websites: any = result.Items;

        // Clean results
        const onlineOrderingWebsites = [];
        let websiteOnlineOrderingAlive = false;
        for (let website of websites) {
            if (website["websiteReportingEmailAddress"] === appConstants.NA) {
                continue;
            }
            websiteOnlineOrderingAlive = false;
            website["websiteId"] = website["sk"].split("#")[1];
            website["websiteCreatorUserId"] = website["itemAncestor"].split("#")[1];
            website["websiteMemberStatus"] = appConstants.DYNAMO_ENTITY_APPROVED;
            website["websiteMemberPermission"] = appConstants.USER_PERMISSION_ADMIN;
            if (typeof website["websiteLastheartbeatTimestamp"] === "number") {
                websiteOnlineOrderingAlive = Date.now() - website["websiteLastheartbeatTimestamp"] < 5 * 60 * 1000;
            }
            website["websiteOnlineOrderingAlive"] = websiteOnlineOrderingAlive;
            delete website["pk"];
            delete website["sk"];
            delete website["itemAncestor"];
            onlineOrderingWebsites.push(website);
        }

        return {
            "websites": onlineOrderingWebsites,
            "lastEvaluatedKey": result.LastEvaluatedKey,
        };
    } catch (e) {
        console.error("In getOnlineOrderingWebsites", e);
        throw "Could not getOnlineOrderingWebsites";
    }
}

////////////////////////////////////////
// Generate Website Invoice
////////////////////////////////////////
export async function generateWebsiteInvoice(
    userId: any, 
    websiteId: any, 
    periodStartTimestamp: any, 
    periodEndTimestamp: any, 
    isIncludeServiceFee: any, 
    discountAmountCents: any,
    ) {
    try {
        const websiteInfo: any = await getWebsiteInfo(websiteId);
        const epochSeconds = Math.round((new Date()).getTime() / 1000);
        const websiteTimezoneData = await getLatLngTimezoneData(websiteInfo.websiteBusinessLocation.latLng.latitude, websiteInfo.websiteBusinessLocation.latLng.longitude, epochSeconds);

        // Covert string timestamps to epoch timestamps
        const periodStartTimestampEpoch = getUtcTimestamp(periodStartTimestamp, "start");
        const periodStartTimestampEpochLocal = periodStartTimestampEpoch - (websiteTimezoneData.dstOffset + websiteTimezoneData.rawOffset) * 1000;

        const periodEndTimestampEpoch = getUtcTimestamp(periodEndTimestamp, "end");
        const periodEndTimestampEpochLocal = periodEndTimestampEpoch - (websiteTimezoneData.dstOffset + websiteTimezoneData.rawOffset) * 1000;

        // Fetch website info & Online orders
        const invoiceDateTimestampUTC: number = Date.now();
        const onlineOrders = await getWebsiteCompletedOnlineOrders(websiteId, periodStartTimestampEpochLocal, periodEndTimestampEpochLocal);
        const numberOfDays = getDaysBetweenTimestamps(periodStartTimestampEpoch, periodEndTimestampEpoch);

        // Create invoice pages
        let totalItemNumber = onlineOrders.length;
        if (isIncludeServiceFee) {
            totalItemNumber++;
        }
        if (discountAmountCents > 0) {
            totalItemNumber++;
        }
        const invoiceNumOfPages = Math.ceil(totalItemNumber / appConstants.ONLINE_ORDERING_INVOICE_ITEMS_PER_PAGE);
        const invoiceItemPages: any[] = [];
        let onlineOrder;
        let totalAmount = 0;
        if (isIncludeServiceFee) {
            totalAmount += websiteInfo.serviceFee * numberOfDays / 30;
        }
        for (let p = 0; p < invoiceNumOfPages; p++) {
            invoiceItemPages.push([]);
            for (let i = p * appConstants.ONLINE_ORDERING_INVOICE_ITEMS_PER_PAGE; i < Math.min(p * appConstants.ONLINE_ORDERING_INVOICE_ITEMS_PER_PAGE + appConstants.ONLINE_ORDERING_INVOICE_ITEMS_PER_PAGE, onlineOrders.length); i++) {
                onlineOrder = onlineOrders[i];
                invoiceItemPages[p].push(
                    {
                        "itemType": appConstants.ONLINE_ORDERING_INVOICE_ITEMS_TYPE_ORDER_ITEM,
                        "orderId": onlineOrder.orderId,
                        "orderCode": onlineOrder.orderCode,
                        "date": formatDateFromTimestamp(onlineOrder.orderUpdatedAt, websiteInfo.websiteTimezoneData.timeZoneId),
                        "description": `Order ${onlineOrder.orderCode} (${onlineOrder.orderCustomerName.length > 12 ? onlineOrder.orderCustomerName.slice(0, 12) : onlineOrder.orderCustomerName}, ${onlineOrder.orderCustomerPhoneNumber})`,
                        "orderAmount": (Number(onlineOrder.orderTotal.toFixed(2)) * 100).toFixed(0),
                        "fee": `${Number(onlineOrder.orderHandlingFee.toFixed(2)) * 100}`,
                        "total": "",
                    }
                );
                totalAmount += Number(onlineOrder.orderHandlingFee);
            }
        }
        if (isIncludeServiceFee) {
            invoiceItemPages[invoiceItemPages.length - 1].push({
                "itemType": appConstants.ONLINE_ORDERING_INVOICE_ITEMS_TYPE_SERVICE_FEE_ITEM,
                "date": formatDateFromTimestamp(invoiceDateTimestampUTC, websiteInfo.websiteTimezoneData.timeZoneId),
                "description": `Service fee (${numberOfDays} days)`,
                "orderAmount": "",
                "fee": `${Number((websiteInfo.serviceFee * numberOfDays / 30).toFixed(2)) * 100}`,
                "total": ""
            });
        }
        if (discountAmountCents > 0) {
            invoiceItemPages[invoiceItemPages.length - 1].push({
                "itemType": appConstants.ONLINE_ORDERING_INVOICE_ITEMS_TYPE_DISCOUNT_ITEM,
                "date": formatDateFromTimestamp(invoiceDateTimestampUTC, websiteInfo.websiteTimezoneData.timeZoneId),
                "description": `Courtesy discount`,
                "orderAmount": "",
                "fee": `-${discountAmountCents}`,
                "total": ""
            });
        }
        let totalAmountCents = Math.round(totalAmount * 100);
        if (discountAmountCents >= totalAmountCents) {
            totalAmountCents = 0;
        } else {
            totalAmountCents -= discountAmountCents;
        }

        // Summarize invoice data
        const businessAddressArr = websiteInfo.websiteBusinessAddress.split(", ");
        const invoiceData = {
            "invoiceInfo": {
                "invoiceNumber": Math.round(invoiceDateTimestampUTC / 1000),
                "billingPeriod": `${periodStartTimestamp} to ${periodEndTimestamp}`,
                "invoiceDate": formatDateFromTimestamp(invoiceDateTimestampUTC, websiteInfo.websiteTimezoneData.timeZoneId),
                "amountDue": totalAmountCents,
                "amountDueDate": formatDateFromTimestamp(invoiceDateTimestampUTC + appConstants.ONLINE_ORDERING_INVOICE_DUE_GRACE_PERIOD_MILLI, websiteInfo.websiteTimezoneData.timeZoneId),
            },
            "invoiceBusinessInfo": {
                "businessName": websiteInfo.websiteBusinessName,
                "streetAddress": businessAddressArr[0],
                "city": businessAddressArr[1],
                "postalCode": "",
                "state": "",
                "country": businessAddressArr[2]
            },
            "invoiceItemPages": invoiceItemPages,
            "invoiceMetadata": {
                "userId": userId,
                "websiteId": websiteId,
                "invoiceId": `${invoiceDateTimestampUTC}`,
                "periodStartTimestamp": periodStartTimestamp,
                "periodStartTimestampEpoch": periodStartTimestampEpoch,
                "periodEndTimestamp": periodEndTimestamp,
                "periodEndTimestampEpoch": periodEndTimestampEpoch,
                "isIncludeServiceFee": isIncludeServiceFee,
                "discountAmountCents": discountAmountCents,
                "pdfS3Key": `website/${websiteId}/${appConstants.S3_FOLDER_ONLINE_ORDERING_INVOICES}/${invoiceDateTimestampUTC}.pdf`
            }
        };

        // Generate invoice PDF
        await generateInvoice(websiteId, invoiceDateTimestampUTC, invoiceData);

        // Create DB record
        await createWebsiteInvoiceRecord(userId, websiteId, invoiceDateTimestampUTC, invoiceData);

        return invoiceData;
    } catch (e) {
        console.error("In generateWebsiteInvoice", e);
        throw "Could not generateWebsiteInvoice";
    }
}

export async function sendInvoice(
    websiteId: any,
    invoiceId: any,
) {
    try {
        const websiteInfo: any = await getWebsiteInfo(websiteId);
        const invoiceRecord: any = await getWebsiteInvoiceRecord(websiteId, invoiceId);
        const billingPeriodArr = invoiceRecord.websiteInvoiceData.invoiceInfo.billingPeriod.split(" to ");
        const billingPeriodFromArr = billingPeriodArr[0].split("-");
        const billingPeriodToArr = billingPeriodArr[1].split("-");
        invoiceRecord.websiteInvoiceData.invoiceInfo.billingPeriod = `${billingPeriodFromArr[2]}/${billingPeriodFromArr[1]}/${billingPeriodFromArr[0]} - ${billingPeriodToArr[2]}/${billingPeriodToArr[1]}/${billingPeriodToArr[0]}`;
        const invoicePdfBase64 = await getObjectBase64(`${appConstants.S3_STORAGE_BUCKET_PREFIX}${STAGE}`, invoiceRecord.websiteInvoiceData.invoiceMetadata.pdfS3Key);
        await sendWooInvoiceEmail({
            toEmailAddress: websiteInfo["websiteReportingEmailAddress"],
            subject: `Your Diner's Xpress invoice`,
            header: `Hello ${websiteInfo["websiteReportingCorrespondentName"].split(" ")[0]},`,
            message: `Your Invoice for ${invoiceRecord.websiteInvoiceData.invoiceInfo.billingPeriod} billing period is attached to this email as a PDF.`,
            invoiceRecord: invoiceRecord.websiteInvoiceData,
            invoicePdf: invoicePdfBase64,
            businessLocale: websiteInfo.websiteBusinessLocale
        });
        return;
    } catch (e) {
        console.error("In sendInvoice", e);
        throw "Could not sendInvoice";
    }
}