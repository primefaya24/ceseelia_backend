// Imports
import {DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {
    DeleteCommand,
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    QueryCommand,
    UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import * as ULID from "ulid";
import {appConstants} from "../../../../../constants";
import {STAGE} from "../../../../../config";
import {dynamGetManyItems, dynamoWriteManyItems} from "../../dynamo-batch-ops";
import {
    generateOrderCode,
    getLocalizedDate,
    getLocalizedTimestamp
} from "../../../../core/utils";
import {deleteObject, getDownloadSignedUrl} from "../../../s3";
import {dqs} from "../../../../../index";
import {fetchUserFcmTokenByEmail, sendPushNotification} from "../../../../gcp/fcm";
import {
    OrderOnlinePaymentHandledPerson,
    OrderOnlinePaymentIntentSucceeded, OrderOnlinePaymentRefundedCharge,
    OrderOnlinePaymentSessionCompleted
} from "../../../../core/interfaces/stripe/indes";
import Stripe from "stripe";

// Initialize DynamoDB Document Client
const dynamoDbDocumentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({
        region: appConstants.DEFAULT_REGION,
    })
);

// Constants
const DEFAULT_TABLE_NAME: string | undefined = `${appConstants.DYNAMO_TABLE_PREFIX}${STAGE}`;

////////////////////////////////////////
// Create Website
////////////////////////////////////////
export async function createWebsite(
    userId: any,
    userEmail: any,
    websiteName: any,
    websiteDomain: any,
    websiteReportingCorrespondentName: any,
    websiteReportingEmailAddress: any,
    websiteBusinessLocation: any,
    websiteBusinessLocale: any,
    websiteTimezoneData: any,
    websiteStartDate: any,
    websiteLogoUri: any,
    websiteGalleryIncluded: any,
    websitePricingIncluded: any,
    websiteSettingsIncluded: any,
    websiteOnlineOrderingIncluded: any,
    websiteOnlineOrderingPaymentEnforced: any,
    websiteCurrencySign: any,
    websiteMaxImageCount: any,
    websiteMinHighlightedPhotos: any,
    websiteMaxHighlightedPhotos: any,
    websiteBusinessName: any,
    websiteBusinessAddress: any,
    websiteSecretName: any,
    websiteAdminPasscode: any,
    websiteStripeSk: any,
    websiteStripeWhsec: any,
    websiteIsOnlineOrderingAvailable: any,
    websiteIsPickUpAvailable: any,
    websiteIsDeliveryAvailable: any,
    websiteIsScheduleAvailable: any,
    websiteOnlineOrderingStartTimeHHMM: any,
    websiteOnlineOrderingEndTimeHHMM: any,
    websiteOnlineOrderingTaxes: any,
    websiteTheme: any,
    websitePrimaryBackgroundColor: any,
    websiteSecondaryBackgroundColor: any,
    websiteTertiaryBackgroundColor: any,
    websitePrimaryTextColor: any,
    websiteSecondaryTextColor: any,
    websiteTertiaryTextColor: any,
    websitePrimaryTextInvertColor: any,
    websiteSecondaryTextInvertColor: any,
    websiteTertiaryTextInvertColor: any,
    serviceFee: any,
    handlingFee: any,
    deliveryFee: any,
    rewardDollarValue: any,
    minRewardDollarsToRedeem: any,
): Promise<any> {
    try {
        const websiteId = ULID.ulid();
        const createdAt = Date.now();

        // Write batch
        const websiteItem = {
            "pk": appConstants.DYNAMO_ENTITY_APP + "#" + appConstants.DYNAMO_ENTITY_WEBSITE,
            "sk": appConstants.DYNAMO_ENTITY_INFO + "#" + websiteId,
            "websiteName": websiteName,
            "websiteDomain": websiteDomain,
            "websiteBusinessLocale": websiteBusinessLocale,
            "websiteTimezoneData": websiteTimezoneData,
            "websiteReportingCorrespondentName": websiteReportingCorrespondentName,
            "websiteReportingEmailAddress": websiteReportingEmailAddress.length > 0 ? websiteReportingEmailAddress : appConstants.NA,
            "websiteBusinessLocation": websiteBusinessLocation,
            "websiteStartDate": websiteStartDate,
            "websiteLogoUri": websiteLogoUri,
            "websiteGalleryIncluded": websiteGalleryIncluded,
            "websitePricingIncluded": websitePricingIncluded,
            "websiteSettingsIncluded": websiteSettingsIncluded,
            "websiteOnlineOrderingIncluded": websiteOnlineOrderingIncluded,
            "websiteOnlineOrderingPaymentEnforced": websiteOnlineOrderingPaymentEnforced,
            "websiteCurrencySign": websiteCurrencySign,
            "websiteMaxImageCount": Math.min(websiteMaxImageCount, 50),
            "websiteMinHighlightedPhotos": websiteMinHighlightedPhotos,
            "websiteMaxHighlightedPhotos": websiteMaxHighlightedPhotos,
            "websiteBusinessName": websiteBusinessName,
            "websiteBusinessAddress": websiteBusinessAddress,
            "websiteSecretName": websiteSecretName,
            "websiteAdminPasscode": websiteAdminPasscode,
            "websiteStripeSk": "", // Using kms
            "websiteStripeWhsec": "", // Using kms
            "websiteIsOnlineOrderingAvailable": websiteIsOnlineOrderingAvailable,
            "websiteIsPickUpAvailable": websiteIsPickUpAvailable,
            "websiteIsDeliveryAvailable": websiteIsDeliveryAvailable,
            "websiteIsScheduleAvailable": websiteIsScheduleAvailable,
            "websiteOnlineOrderingStartTimeHHMM": websiteOnlineOrderingStartTimeHHMM,
            "websiteOnlineOrderingEndTimeHHMM": websiteOnlineOrderingEndTimeHHMM,
            "websiteOnlineOrderingTaxes": websiteOnlineOrderingTaxes,
            "websiteTheme": websiteTheme,
            "websitePrimaryBackgroundColor": websitePrimaryBackgroundColor,
            "websiteSecondaryBackgroundColor": websiteSecondaryBackgroundColor,
            "websiteTertiaryBackgroundColor": websiteTertiaryBackgroundColor,
            "websitePrimaryTextColor": websitePrimaryTextColor,
            "websitePrimaryTextInvertColor": websitePrimaryTextInvertColor,
            "websiteSecondaryTextColor": websiteSecondaryTextColor,
            "websiteSecondaryTextInvertColor": websiteSecondaryTextInvertColor,
            "websiteTertiaryTextColor": websiteTertiaryTextColor,
            "websiteTertiaryTextInvertColor": websiteTertiaryTextInvertColor,
            "serviceFee": serviceFee,
            "handlingFee": handlingFee,
            "deliveryFee": deliveryFee,
            "rewardDollarValue": rewardDollarValue,
            "minRewardDollarsToRedeem": minRewardDollarsToRedeem,
            "websiteTotalVisitors": 0,
            "websiteTotalVisitorTimeSpentMillis": 0,
            "websiteCreatedAt": createdAt,
            "itemAncestor": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
        };
        if (websiteReportingEmailAddress.length > 0) {
            websiteItem["websiteReportingEmailAddress"] = websiteReportingEmailAddress;
        }

        await dynamoWriteManyItems(DEFAULT_TABLE_NAME, [
            // Website
            {
                PutRequest: {
                    Item: websiteItem
                }
            },
            // Website Data
            {
                PutRequest: {
                    Item: {
                        "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                        "sk": appConstants.DYNAMO_ENTITY_DATA + "#" + createdAt,
                        "websiteData": {
                            "version": 0,
                            "photoGallery": {
                                "imageUris": [],
                                "highlightedImageUris": [],
                            },
                            "pricing": {
                                "pageTitle": "",
                                "pageSubtitle": "",
                                "categories": [],
                            },
                            "settings": {
                                "promoImageUri": ""
                            }
                        },
                        "itemAncestor": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
                    }
                }
            },
            // Website Membership
            {
                PutRequest: {
                    Item: {
                        "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                        "sk": appConstants.DYNAMO_ENTITY_MEMBER + "#" + userEmail,
                        "websiteMemberFirstName": appConstants.YOU,
                        "websiteMemberLastName": "",
                        "websiteMemberStatus": appConstants.DYNAMO_ENTITY_APPROVED,
                        "websiteMemberPermission": appConstants.USER_PERMISSION_ADMIN,
                        "websiteMemberUserEmail": userEmail,
                        "websiteMemberPhoneNumber": "",
                        "websiteMemberSideNote": "",
                        "websiteMembershipLastUpdated": createdAt,
                    }
                }
            },
        ]);

        // Clean website item
        return {
            "websiteId": websiteItem["sk"].split("#")[1],
            "websiteName": websiteItem["websiteName"],
            "websiteDomain": websiteItem["websiteDomain"],
            "websiteCreatorUserId": userId,
            "websiteMemberStatus": appConstants.DYNAMO_ENTITY_APPROVED,
            "websiteMemberPermission": appConstants.USER_PERMISSION_ADMIN,
            "websiteStartDate": websiteItem["websiteStartDate"],
            "websiteCurrencySign": websiteItem["websiteCurrencySign"],
            "websiteLogoUri": websiteItem["websiteLogoUri"],
            "websiteGalleryIncluded": websiteItem["websiteGalleryIncluded"],
            "websitePricingIncluded": websiteItem["websitePricingIncluded"],
            "websiteMaxImageCount": websiteItem["websiteMaxImageCount"],
            "websiteMinHighlightedPhotos": websiteItem["websiteMinHighlightedPhotos"],
            "websiteMaxHighlightedPhotos": websiteItem["websiteMaxHighlightedPhotos"],
            "websiteTotalVisitors": websiteItem["websiteTotalVisitors"],
            "websiteTotalVisitorTimeSpentMillis": websiteItem["websiteTotalVisitorTimeSpentMillis"],
            "websiteCreatedAt": websiteItem["websiteCreatedAt"],
        };
    } catch (e) {
        console.error("In createWebsite", e);
        throw "Could not createWebsite";
    }
}

////////////////////////////////////////
// Update Website
////////////////////////////////////////
export async function updateWebsite(
    websiteId: any,
    websiteName: any,
    websiteDomain: any,
    websiteReportingCorrespondentName: any,
    websiteReportingEmailAddress: any,
    websiteBusinessLocation: any,
    websiteBusinessLocale: any,
    websiteTimezoneData: any,
    websiteStartDate: any,
    websiteLogoUri: any,
    websiteGalleryIncluded: any,
    websitePricingIncluded: any,
    websiteSettingsIncluded: any,
    websiteOnlineOrderingIncluded: any,
    websiteOnlineOrderingPaymentEnforced: any,
    websiteCurrencySign: any,
    websiteMaxImageCount: any,
    websiteMinHighlightedPhotos: any,
    websiteMaxHighlightedPhotos: any,
    websiteBusinessName: any,
    websiteBusinessAddress: any,
    websiteSecretName: any,
    websiteAdminPasscode:any,
    websiteStripeSk: any,
    websiteStripeWhsec: any,
    websiteIsOnlineOrderingAvailable: any,
    websiteIsPickUpAvailable: any,
    websiteIsDeliveryAvailable: any,
    websiteIsScheduleAvailable: any,
    websiteOnlineOrderingStartTimeHHMM: any,
    websiteOnlineOrderingEndTimeHHMM: any,
    websiteOnlineOrderingTaxes: any,
    websiteTheme: any,
    websitePrimaryBackgroundColor: any,
    websiteSecondaryBackgroundColor: any,
    websiteTertiaryBackgroundColor: any,
    websitePrimaryTextColor: any,
    websiteSecondaryTextColor: any,
    websiteTertiaryTextColor: any,
    websitePrimaryTextInvertColor: any,
    websiteSecondaryTextInvertColor: any,
    websiteTertiaryTextInvertColor: any,
    serviceFee: any,
    handlingFee: any,
    deliveryFee: any,
    rewardDollarValue: any,
    minRewardDollarsToRedeem: any,
) {
    try {
        const command = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_APP + "#" + appConstants.DYNAMO_ENTITY_WEBSITE,
                "sk": appConstants.DYNAMO_ENTITY_INFO + "#" + websiteId,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #websiteName = :websiteName, #websiteDomain = :websiteDomain, #websiteReportingCorrespondentName = :websiteReportingCorrespondentName, #websiteReportingEmailAddress = :websiteReportingEmailAddress, #websiteBusinessLocation = :websiteBusinessLocation, #websiteBusinessLocale = :websiteBusinessLocale, #websiteTimezoneData = :websiteTimezoneData, #websiteStartDate = :websiteStartDate, #websiteLogoUri = :websiteLogoUri" +
                ", #websiteGalleryIncluded = :websiteGalleryIncluded, #websitePricingIncluded = :websitePricingIncluded,  #websiteSettingsIncluded = :websiteSettingsIncluded,  #websiteOnlineOrderingIncluded = :websiteOnlineOrderingIncluded, #websiteOnlineOrderingPaymentEnforced = :websiteOnlineOrderingPaymentEnforced, #websiteCurrencySign = :websiteCurrencySign, #websiteMaxImageCount = :websiteMaxImageCount, #websiteMinHighlightedPhotos = :websiteMinHighlightedPhotos" +
                ", #websiteMaxHighlightedPhotos = :websiteMaxHighlightedPhotos, #websiteBusinessName = :websiteBusinessName, #websiteBusinessAddress = :websiteBusinessAddress, #websiteSecretName = :websiteSecretName, #websiteAdminPasscode = :websiteAdminPasscode, #websiteStripeSk = :websiteStripeSk, #websiteStripeWhsec = :websiteStripeWhsec" +
                ", #websiteIsOnlineOrderingAvailable = :websiteIsOnlineOrderingAvailable, #websiteIsPickUpAvailable = :websiteIsPickUpAvailable, #websiteIsDeliveryAvailable = :websiteIsDeliveryAvailable, #websiteIsScheduleAvailable = :websiteIsScheduleAvailable, #websiteOnlineOrderingStartTimeHHMM = :websiteOnlineOrderingStartTimeHHMM, #websiteOnlineOrderingEndTimeHHMM = :websiteOnlineOrderingEndTimeHHMM, #websiteOnlineOrderingTaxes = :websiteOnlineOrderingTaxes" +
                ", #websiteTheme = :websiteTheme, #websitePrimaryBackgroundColor = :websitePrimaryBackgroundColor, #websiteSecondaryBackgroundColor = :websiteSecondaryBackgroundColor, #websiteTertiaryBackgroundColor = :websiteTertiaryBackgroundColor, #websitePrimaryTextColor = :websitePrimaryTextColor, #websiteSecondaryTextColor = :websiteSecondaryTextColor, #websiteTertiaryTextColor = :websiteTertiaryTextColor" +
                ", #websitePrimaryTextInvertColor = :websitePrimaryTextInvertColor, #websiteSecondaryTextInvertColor = :websiteSecondaryTextInvertColor, #websiteTertiaryTextInvertColor = :websiteTertiaryTextInvertColor, #serviceFee = :serviceFee, #handlingFee = :handlingFee, #deliveryFee = :deliveryFee, #rewardDollarValue = :rewardDollarValue, #minRewardDollarsToRedeem = :minRewardDollarsToRedeem",
            ExpressionAttributeNames: {
                '#websiteName': 'websiteName',
                '#websiteDomain': 'websiteDomain',
                "#websiteReportingCorrespondentName": 'websiteReportingCorrespondentName',
                '#websiteReportingEmailAddress': 'websiteReportingEmailAddress',
                '#websiteBusinessLocation': 'websiteBusinessLocation',
                '#websiteBusinessLocale': 'websiteBusinessLocale',
                '#websiteTimezoneData': 'websiteTimezoneData',
                '#websiteStartDate': 'websiteStartDate',
                '#websiteLogoUri': 'websiteLogoUri',
                '#websiteGalleryIncluded': 'websiteGalleryIncluded',
                '#websitePricingIncluded': 'websitePricingIncluded',
                '#websiteSettingsIncluded': 'websiteSettingsIncluded',
                '#websiteOnlineOrderingIncluded': 'websiteOnlineOrderingIncluded',
                '#websiteOnlineOrderingPaymentEnforced': 'websiteOnlineOrderingPaymentEnforced',
                '#websiteCurrencySign': 'websiteCurrencySign',
                '#websiteMaxImageCount': 'websiteMaxImageCount',
                '#websiteMinHighlightedPhotos': 'websiteMinHighlightedPhotos',
                '#websiteMaxHighlightedPhotos': 'websiteMaxHighlightedPhotos',
                "#websiteBusinessName": "websiteBusinessName",
                "#websiteBusinessAddress": "websiteBusinessAddress",
                "#websiteSecretName": "websiteSecretName",
                "#websiteAdminPasscode": "websiteAdminPasscode",
                "#websiteStripeSk": "websiteStripeSk",
                "#websiteStripeWhsec": "websiteStripeWhsec",
                "#websiteIsOnlineOrderingAvailable": "websiteIsOnlineOrderingAvailable",
                "#websiteIsPickUpAvailable": "websiteIsPickUpAvailable",
                "#websiteIsDeliveryAvailable": "websiteIsDeliveryAvailable",
                "#websiteIsScheduleAvailable": "websiteIsScheduleAvailable",
                "#websiteOnlineOrderingStartTimeHHMM": "websiteOnlineOrderingStartTimeHHMM",
                "#websiteOnlineOrderingEndTimeHHMM": "websiteOnlineOrderingEndTimeHHMM",
                "#websiteOnlineOrderingTaxes": "websiteOnlineOrderingTaxes",
                "#websiteTheme": "websiteTheme",
                "#websitePrimaryBackgroundColor": "websitePrimaryBackgroundColor",
                "#websiteSecondaryBackgroundColor": "websiteSecondaryBackgroundColor",
                "#websiteTertiaryBackgroundColor": "websiteTertiaryBackgroundColor",
                "#websitePrimaryTextColor": "websitePrimaryTextColor",
                "#websitePrimaryTextInvertColor": "websitePrimaryTextInvertColor",
                "#websiteSecondaryTextColor": "websiteSecondaryTextColor",
                "#websiteSecondaryTextInvertColor": "websiteSecondaryTextInvertColor",
                "#websiteTertiaryTextColor": "websiteTertiaryTextColor",
                "#websiteTertiaryTextInvertColor": "websiteTertiaryTextInvertColor",
                "#serviceFee": "serviceFee",
                "#handlingFee": "handlingFee",
                "#deliveryFee": "deliveryFee",
                "#rewardDollarValue": "rewardDollarValue",
                "#minRewardDollarsToRedeem": "minRewardDollarsToRedeem"
            },
            ExpressionAttributeValues: {
                ":websiteName": websiteName,
                ":websiteDomain": websiteDomain,
                ":websiteReportingCorrespondentName": websiteReportingCorrespondentName,
                ":websiteReportingEmailAddress": websiteReportingEmailAddress.length > 0 ? websiteReportingEmailAddress : appConstants.NA,
                ":websiteBusinessLocation": websiteBusinessLocation,
                ":websiteBusinessLocale": websiteBusinessLocale,
                ":websiteTimezoneData": websiteTimezoneData,
                ":websiteStartDate": websiteStartDate,
                ":websiteLogoUri": websiteLogoUri,
                ":websiteGalleryIncluded": websiteGalleryIncluded,
                ":websitePricingIncluded": websitePricingIncluded,
                ":websiteSettingsIncluded": websiteSettingsIncluded,
                ":websiteOnlineOrderingIncluded": websiteOnlineOrderingIncluded,
                ":websiteOnlineOrderingPaymentEnforced": websiteOnlineOrderingPaymentEnforced,
                ":websiteCurrencySign": websiteCurrencySign,
                ":websiteMaxImageCount": websiteMaxImageCount,
                ":websiteMinHighlightedPhotos": websiteMinHighlightedPhotos,
                ":websiteMaxHighlightedPhotos": websiteMaxHighlightedPhotos,
                ":websiteBusinessName": websiteBusinessName,
                ":websiteBusinessAddress": websiteBusinessAddress,
                ":websiteSecretName": websiteSecretName,
                ":websiteAdminPasscode": websiteAdminPasscode,
                ":websiteStripeSk": "", // Using kms
                ":websiteStripeWhsec": "", // Using kms
                ":websiteIsOnlineOrderingAvailable": websiteIsOnlineOrderingAvailable,
                ":websiteIsPickUpAvailable": websiteIsPickUpAvailable,
                ":websiteIsDeliveryAvailable": websiteIsDeliveryAvailable,
                ":websiteIsScheduleAvailable": websiteIsScheduleAvailable,
                ":websiteOnlineOrderingStartTimeHHMM": websiteOnlineOrderingStartTimeHHMM,
                ":websiteOnlineOrderingEndTimeHHMM": websiteOnlineOrderingEndTimeHHMM,
                ":websiteOnlineOrderingTaxes": websiteOnlineOrderingTaxes,
                ":websiteTheme": websiteTheme,
                ":websitePrimaryBackgroundColor": websitePrimaryBackgroundColor,
                ":websiteSecondaryBackgroundColor": websiteSecondaryBackgroundColor,
                ":websiteTertiaryBackgroundColor": websiteTertiaryBackgroundColor,
                ":websitePrimaryTextColor": websitePrimaryTextColor,
                ":websitePrimaryTextInvertColor": websitePrimaryTextInvertColor,
                ":websiteSecondaryTextColor": websiteSecondaryTextColor,
                ":websiteSecondaryTextInvertColor": websiteSecondaryTextInvertColor,
                ":websiteTertiaryTextColor": websiteTertiaryTextColor,
                ":websiteTertiaryTextInvertColor": websiteTertiaryTextInvertColor,
                ":serviceFee": serviceFee,
                ":handlingFee": handlingFee,
                ":deliveryFee": deliveryFee,
                ":rewardDollarValue": rewardDollarValue,
                ":minRewardDollarsToRedeem": minRewardDollarsToRedeem,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In updateWebsite", e);
        throw "Could not updateWebsite";
    }
}

////////////////////////////////////////
// Update Website Last Invoice Info
////////////////////////////////////////
export async function updateWebsiteWooLastInvoiceInfo(
    websiteId: any, 
    invoiceId: any, 
    invoiceDate: any, 
    invoiceAmountDue: any, 
    invoicePaid : boolean= false
) {
    try {
        const command = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_APP + "#" + appConstants.DYNAMO_ENTITY_WEBSITE,
                "sk": appConstants.DYNAMO_ENTITY_INFO + "#" + websiteId,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #websiteLastInvoiceId = :websiteLastInvoiceId, #websiteLastInvoiceDate = :websiteLastInvoiceDate, #websiteLastInvoiceAmountDue = :websiteLastInvoiceAmountDue, #websiteLastInvoicePaid = :websiteLastInvoicePaid",
            ExpressionAttributeNames: {
                "#websiteLastInvoiceId": "websiteLastInvoiceId",
                "#websiteLastInvoiceDate": "websiteLastInvoiceDate",
                "#websiteLastInvoiceAmountDue": "websiteLastInvoiceAmountDue",
                "#websiteLastInvoicePaid": "websiteLastInvoicePaid",
            },
            ExpressionAttributeValues: {
                ":websiteLastInvoiceId": invoiceId,
                ":websiteLastInvoiceDate": invoiceDate,
                ":websiteLastInvoiceAmountDue": invoiceAmountDue,
                ":websiteLastInvoicePaid": invoicePaid,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In updateWebsiteWooLastInvoiceInfo", e);
        throw "Could not updateWebsiteWooLastInvoiceInfo";
    }
}

////////////////////////////////////////
// Confirm Website Last Invoice payment
////////////////////////////////////////
export async function confirmWebsiteWooLastInvoicePayment(
    websiteId: any,
) {
    try {
        const command = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_APP + "#" + appConstants.DYNAMO_ENTITY_WEBSITE,
                "sk": appConstants.DYNAMO_ENTITY_INFO + "#" + websiteId,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #websiteLastInvoicePaid = :websiteLastInvoicePaid",
            ExpressionAttributeNames: {
                "#websiteLastInvoicePaid": "websiteLastInvoicePaid",
            },
            ExpressionAttributeValues: {
                ":websiteLastInvoicePaid": true,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In confirmWebsiteWooLastInvoicePayment", e);
        throw "Could not confirmWebsiteWooLastInvoicePayment";
    }
}

////////////////////////////////////////
// Update Website online ordering availability
////////////////////////////////////////
export async function updateWebsiteOnlineOrderingAvailability(
    websiteId: any, 
    websiteIsOnlineOrderingAvailable: any,
) {
    try {
        const command = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_APP + "#" + appConstants.DYNAMO_ENTITY_WEBSITE,
                "sk": appConstants.DYNAMO_ENTITY_INFO + "#" + websiteId,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #websiteIsOnlineOrderingAvailable = :websiteIsOnlineOrderingAvailable",
            ExpressionAttributeNames: {
                "#websiteIsOnlineOrderingAvailable": "websiteIsOnlineOrderingAvailable",
            },
            ExpressionAttributeValues: {
                ":websiteIsOnlineOrderingAvailable": websiteIsOnlineOrderingAvailable,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In updateWebsiteOnlineOrderingAvailability", e);
        throw "Could not updateWebsiteOnlineOrderingAvailability";
    }
}

////////////////////////////////////////
// Get Website Info
////////////////////////////////////////
export async function getWebsiteInfo(
    websiteId: any,
) {
    try {
        const command = new GetCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_APP + "#" + appConstants.DYNAMO_ENTITY_WEBSITE,
                "sk": appConstants.DYNAMO_ENTITY_INFO + "#" + websiteId,
            }
        });
        return (await dynamoDbDocumentClient.send(command)).Item;
    } catch (e) {
        console.error("In getWebsiteInfo", e);
        throw "Could not getWebsiteInfo";
    }
}

export async function getWebsiteMembershipsRecords(
    websiteId: any,
) {
    try {
        const command = new QueryCommand({
            TableName: DEFAULT_TABLE_NAME,
            KeyConditionExpression: "#pk = :pk and begins_with(#sk, :sk_prefix)",
            ExpressionAttributeNames: {
                "#pk": "pk",
                "#sk": "sk"
            },
            ExpressionAttributeValues: {
                ":pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                ":sk_prefix": appConstants.DYNAMO_ENTITY_MEMBER + "#"
            },
            ScanIndexForward: false,
        });
        const result = await dynamoDbDocumentClient.send(command);
        return result.Items;
    } catch (e) {
        console.error("In getWebsiteMembershipsRecords", e);
        throw "Could not getWebsiteMembershipsRecords";
    }
}

////////////////////////////////////////
// Get Website Memberships
////////////////////////////////////////
export async function getWebsiteMemberships(
    userEmail: any,
) {
    try {
        let websiteMemberships: any[] = [];
        let lastEvaluatedKey;

        do {
            const command: QueryCommand = new QueryCommand({
                TableName: DEFAULT_TABLE_NAME,
                IndexName: appConstants.INDEX_NAME_WEBSITE_MEMBERSHIP_GSI,
                KeyConditionExpression: "#websiteMemberUserEmail = :websiteMemberUserEmail and begins_with(#pk, :pk_prefix)",
                ExpressionAttributeNames: {
                    "#websiteMemberUserEmail": "websiteMemberUserEmail",
                    "#pk": "pk"
                },
                ExpressionAttributeValues: {
                    ":websiteMemberUserEmail": userEmail,
                    ":pk_prefix": appConstants.DYNAMO_ENTITY_WEBSITE + "#"
                },
                ScanIndexForward: false,
                ExclusiveStartKey: lastEvaluatedKey
            });

            const result = await dynamoDbDocumentClient.send(command);
            websiteMemberships = websiteMemberships.concat(result.Items);

            // Update the lastEvaluatedKey to paginate if more data is available
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey); // Continue fetching data until there's no more

        // Execute batch get
        const batchGetRequestItems = [];
        for (let websiteMembership of websiteMemberships) {
            batchGetRequestItems.push({
                "pk": appConstants.DYNAMO_ENTITY_APP + "#" + appConstants.DYNAMO_ENTITY_WEBSITE,
                "sk": appConstants.DYNAMO_ENTITY_INFO + "#" + websiteMembership["pk"].split("#")[1],
            });
        }
        const websites = await dynamGetManyItems(DEFAULT_TABLE_NAME, batchGetRequestItems);

        // Clear results
        for (let website of websites) {
            website["websiteId"] = website["sk"].split("#")[1];
            website["websiteCreatorUserId"] = website["itemAncestor"].split("#")[1];
            for (let websiteMembership of websiteMemberships) {
                if (websiteMembership["pk"].split("#")[1] === website["websiteId"]) {
                    website["websiteMemberStatus"] = websiteMembership["websiteMemberStatus"];
                    website["websiteMemberPermission"] = websiteMembership["websiteMemberPermission"];
                    break;
                }
            }
            delete website["pk"];
            delete website["sk"];
            delete website["itemAncestor"];
        }

        return websites;
    } catch (e) {
        console.error("In getWebsiteMemberships", e);
        throw "Could not getWebsiteMemberships";
    }
}

////////////////////////////////////////
// Get Website Membership
////////////////////////////////////////
export async function getWebsiteMembership(
    websiteId: any, 
    userEmail: any,
) {
    try {
        const command = new GetCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_MEMBER + "#" + userEmail,
            }
        });
        return (await dynamoDbDocumentClient.send(command)).Item;
    } catch (e) {
        console.error("In getWebsiteMembership", e);
        throw "Could not getWebsiteMembership";
    }
}

////////////////////////////////////////
// Update Website Data
////////////////////////////////////////
export async function updateWebsiteData(
    userId: any, 
    websiteId: any, 
    websiteData: any,
) {
    try {
        // Fetch most recent website data
        const websiteRecentDataVersion = await getWebsiteRecentDataVersion(websiteId);
        websiteData["version"] = websiteRecentDataVersion["websiteData"]["version"] + 1;

        const updatedAt = Date.now();
        const command = new PutCommand({
            TableName: DEFAULT_TABLE_NAME,
            Item: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_DATA + "#" + updatedAt,
                "websiteData": websiteData,
                "itemAncestor": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
            },
        });
        await dynamoDbDocumentClient.send(command);

        // Apply TTL to previous website data
        // await applyTTL(websiteId, websiteRecentDataVersion["websiteDataCreatedAt"]);

        // Clean up website's media if limit reached
        if (websiteData["version"] % appConstants.DATA_VERSIONS_LIMIT === 0) {
            dqs.enqueue({
                topicId: appConstants.SQS_MESSAGE_TOPIC_ID_CLEAN_UP_WEBSITE_UN_USED_MEDIA,
                data: {
                    "websiteId": websiteId,
                }
            });
        }

        return updatedAt;
    } catch (e) {
        console.error("In updateWebsiteData", e);
        throw "Could not updateWebsiteData";
    }
}

////////////////////////////////////////
// Apply TTL on Website data
////////////////////////////////////////
export async function applyTTL(
    websiteId: any, 
    versionDate: any,
) {
    try {
        const updatedAt = Date.now();
        const command = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_DATA + "#" + versionDate,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #ttl = :ttl",
            ExpressionAttributeNames: {
                '#ttl': 'ttl',
            },
            ExpressionAttributeValues: {
                ":ttl": Math.floor(updatedAt / 1000) + appConstants.ONE_YEAR,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In applyTTL", e);
        throw "Could not applyTTL";
    }
}

////////////////////////////////////////
// Get Website Recent Data version
////////////////////////////////////////
export async function getWebsiteRecentDataVersion(
    websiteId: string,
) {
    try {
        const command = new QueryCommand({
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
            Limit: 1
        });
        const result: any = await dynamoDbDocumentClient.send(command);
        const websiteRecentDataVersion = result.Items[0];

        // Clean record
        if (websiteRecentDataVersion) {
            websiteRecentDataVersion["websiteId"] = websiteRecentDataVersion["pk"].split("#")[1];
            websiteRecentDataVersion["websiteDataCreatedAt"] = Number(websiteRecentDataVersion["sk"].split("#")[1]);
            websiteRecentDataVersion["websiteDataCreatorUserId"] = websiteRecentDataVersion["itemAncestor"].split("#")[1];
            delete websiteRecentDataVersion["pk"];
            delete websiteRecentDataVersion["sk"];
            delete websiteRecentDataVersion["itemAncestor"];
        }

        return websiteRecentDataVersion;
    } catch (e) {
        console.error("In getWebsiteRecentDataVersion", e);
        throw "Could not getWebsiteRecentDataVersion";
    }
}

////////////////////////////////////////
// Get Website Recent Data version
////////////////////////////////////////
export async function getWebsiteDataForVersion(
    websiteId: any, 
    versionDate: any,
) {
    try {
        const command = new GetCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_DATA + "#" + versionDate,
            }
        });
        const websiteDataForVersion = (await dynamoDbDocumentClient.send(command)).Item;

        // Clean record
        if (websiteDataForVersion) {
            return websiteDataForVersion["websiteData"];
        }

        return null;
    } catch (e) {
        console.error("In getWebsiteRecentDataVersion", e);
        throw "Could not getWebsiteRecentDataVersion";
    }
}

////////////////////////////////////////
// Get all website Data
////////////////////////////////////////
export async function getAllWebsiteDataKeys(
    websiteId: any,
) {
    try {
        let allWebsiteDataKeys: any[] = [];
        let lastEvaluatedKey;

        do {
            const command: QueryCommand = new QueryCommand({
                TableName: DEFAULT_TABLE_NAME,
                KeyConditionExpression: '#pk = :pk',
                ProjectionExpression: "#pk, #sk",
                ExpressionAttributeNames: {
                    "#pk": "pk",
                    "#sk": "sk",
                },
                ExpressionAttributeValues: {
                    ":pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId
                },
                ExclusiveStartKey: lastEvaluatedKey // for pagination
            });

            const result = await dynamoDbDocumentClient.send(command);
            allWebsiteDataKeys = allWebsiteDataKeys.concat(result.Items);

            // Update the lastEvaluatedKey to paginate if more data is available
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey); // Continue fetching data until there's no more

        return allWebsiteDataKeys;
    } catch (e) {
        console.error("In getAllWebsiteDataKeys", e);
        throw "Could not getAllWebsiteDataKeys";
    }
}

////////////////////////////////////////
// Leave Website
////////////////////////////////////////
export async function leaveWebsite(
    websiteId: any, 
    userEmail: any,
) {
    try {
        const command = new DeleteCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_MEMBER + "#" + userEmail,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In leaveWebsite", e);
        throw "Could not leaveWebsite";
    }
}

////////////////////////////////////////
// Get Website Networking Data version
////////////////////////////////////////
export async function getWebsiteNetworkingData(
    websiteId: any, 
    isPure: boolean = true,
) {
    try {
        const command = new GetCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_NETWORKING,
            }
        });
        const websiteNetworkingData = (await dynamoDbDocumentClient.send(command)).Item;

        // Clean record
        if (websiteNetworkingData) {
            return isPure ? websiteNetworkingData["websiteNetworkingData"] : websiteNetworkingData;
        }

        return null;
    } catch (e) {
        console.error("In getWebsiteNetworkingData", e);
        throw "Could not getWebsiteNetworkingData";
    }
}

////////////////////////////////////////
// Update Website Networking Data
////////////////////////////////////////
export async function updateWebsiteNetworkingData(
    userId: any, 
    websiteId: any, 
    websiteNetworkingData: any,
) {
    try {
        const updatedAt = Date.now();
        const command = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_NETWORKING,
            },
            UpdateExpression: "set #websiteNetworkingData = :websiteNetworkingData, #websiteNetworkingHandleName = :websiteNetworkingHandleName, #itemAncestor = :itemAncestor, #websiteNetworkingDataUpdatedAt = :websiteNetworkingDataUpdatedAt",
            ExpressionAttributeNames: {
                '#websiteNetworkingData': 'websiteNetworkingData',
                '#websiteNetworkingHandleName': 'websiteNetworkingHandleName',
                '#itemAncestor': 'itemAncestor',
                '#websiteNetworkingDataUpdatedAt': 'websiteNetworkingDataUpdatedAt',
            },
            ExpressionAttributeValues: {
                ":websiteNetworkingData": websiteNetworkingData,
                ":websiteNetworkingHandleName": websiteNetworkingData["websiteNetworkingHandle"],
                ":itemAncestor": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
                ":websiteNetworkingDataUpdatedAt": updatedAt,
            },
        });
        await dynamoDbDocumentClient.send(command);
        return updatedAt;
    } catch (e) {
        console.error("In updateWebsiteNetworkingData", e);
        throw "Could not updateWebsiteNetworkingData";
    }
}

////////////////////////////////////////
// Update Website Networking Data CF info
////////////////////////////////////////
export async function updateWebsiteNetworkingDataCfInfo(
    websiteId: any, 
    websiteNetworkingDataCfDistributionId: any, 
    websiteNetworkingDataCfDistributionDomain: any
) {
    try {
        const updatedAt = Date.now();
        const command = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_NETWORKING,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #websiteNetworkingDataCfDistributionId = :websiteNetworkingDataCfDistributionId, #websiteNetworkingDataCfDistributionDomain = :websiteNetworkingDataCfDistributionDomain, #websiteNetworkingDataUpdatedAt = :websiteNetworkingDataUpdatedAt",
            ExpressionAttributeNames: {
                '#websiteNetworkingDataCfDistributionId': 'websiteNetworkingDataCfDistributionId',
                '#websiteNetworkingDataCfDistributionDomain': 'websiteNetworkingDataCfDistributionDomain',
                '#websiteNetworkingDataUpdatedAt': 'websiteNetworkingDataUpdatedAt',
            },
            ExpressionAttributeValues: {
                ":websiteNetworkingDataCfDistributionId": websiteNetworkingDataCfDistributionId,
                ":websiteNetworkingDataCfDistributionDomain": websiteNetworkingDataCfDistributionDomain,
                ":websiteNetworkingDataUpdatedAt": updatedAt,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In updateWebsiteNetworkingDataCfInfo", e);
        throw "Could not updateWebsiteNetworkingDataCfInfo";
    }
}

////////////////////////////////////////
// Get website networking handle
////////////////////////////////////////
export async function getWebsiteNetworkingDataViaHandle(
    websiteNetworkingHandleName: any,
) {
    try {
        const query = {
            TableName: DEFAULT_TABLE_NAME,
            IndexName: appConstants.INDEX_NAME_WEBSITE_NETWORKING_HANDLE_GSI,
            KeyConditionExpression: '#websiteNetworkingHandleName = :websiteNetworkingHandleName',
            ExpressionAttributeNames: {
                "#websiteNetworkingHandleName": "websiteNetworkingHandleName",
            },
            ExpressionAttributeValues: {
                ":websiteNetworkingHandleName": websiteNetworkingHandleName,
            },
            Limit: 1,
        };
        const command = new QueryCommand(query);
        const handleDocArr: any = await dynamoDbDocumentClient.send(command);
        return handleDocArr["Items"][0];
    } catch (e) {
        console.error("In getWebsiteNetworkingDataViaHandle", e);
        throw "Could not get website networking data via handle";
    }
}

////////////////////////////////////////
// Report CF distribution to delete
////////////////////////////////////////
export async function reportCfDistributionToDelete(
    websiteId: any, 
    websiteDomain: any, 
    distributionId: any
) {
    try {
        const command = new PutCommand({
            TableName: DEFAULT_TABLE_NAME,
            Item: {
                "pk": appConstants.DYNAMO_ENTITY_APP + "#" + appConstants.DYNAMO_ENTITY_CFD_TO_DELETE,
                "sk": distributionId,
                "cfDistributionToDeleteWebsiteId": websiteId,
                "cfDistributionToDeleteWebsiteDomain": websiteDomain,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In reportCfDistributionToDelete", e);
        throw "Could not get report CF distribution to delete";
    }
}

////////////////////////////////////////
// Get Website Online Ordering Info
////////////////////////////////////////
export async function getWebsiteOnlineOrderingInfo(
    websiteId: any
) {
    try {
        const [websiteInfo, websiteRecentDataVersion] = await Promise.all([
            new Promise((resolve, reject) => {
                getWebsiteInfo(websiteId)
                    .then((websiteInfo) => {
                        resolve(websiteInfo);
                    })
                    .catch((err) => {
                        reject(err);
                    });
            }),
            new Promise((resolve, reject) => {
                getWebsiteRecentDataVersion(websiteId)
                    .then((websiteRecentDataVersion) => {
                        resolve(websiteRecentDataVersion);
                    })
                    .catch((err) => {
                        reject(err);
                    });
            }),
        ]);
        return {
            "websiteInfo": websiteInfo,
            "websiteRecentDataVersion": websiteRecentDataVersion
        };
    } catch (e) {
        console.error("In getWebsiteOnlineOrderingInfo", e);
        throw "Could not getWebsiteOnlineOrderingInfo";
    }
}

////////////////////////////////////////
// Submit Online Order
////////////////////////////////////////
export async function submitOnlineOrder(
    orderWebsiteId: any, 
    orderWebsiteBusinessName: any, 
    orderWebsiteDataVersion: any, 
    orderCustomerName: any, 
    orderCustomerPhoneNumber: any, 
    orderCustomerPhoneNumberNotification: any,
    orderCustomerAddress: any, 
    orderCustomerEmailAddress: any, 
    orderItems: any, 
    orderNote: any, 
    orderSubtotal: any, 
    orderTaxes: any, 
    orderTotal: any, 
    orderType: any, 
    orderScheduleDateYYYYMMDD: any,
    orderScheduleTimeHHMM: any, 
    orderRewardDollarsRedeemed: any, 
    orderAuthenticatedCustomerUserId: any, 
    orderHandlingFee: any, 
    orderDeliveryFee: any,
    orderOnlinePaymentEnforced: boolean
) {
    try {
        const orderId = ULID.ulid();
        const orderCode = generateOrderCode();
        const orderCreatedAt = Date.now();
        const params: any = {
            TableName: DEFAULT_TABLE_NAME,
            Item: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + orderWebsiteId,
                "sk": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId,
                "orderWebsiteId": orderWebsiteId,
                "orderWebsiteBusinessName": orderWebsiteBusinessName,
                "orderWebsiteDataVersion": orderWebsiteDataVersion,
                "orderId": orderId,
                "orderStatus": (orderOnlinePaymentEnforced ? appConstants.ONLINE_ORDER_STATUS_PENDING_ONLINE_PAYMENT : appConstants.ONLINE_ORDER_STATUS_NOT_DELIVERED_PREFIX) + "#" + appConstants.ONLINE_ORDER_STATUS_NOT_ACKNOWLEDGED + "#" + orderCreatedAt,
                "orderCode": orderCode,
                "orderCustomerName": orderCustomerName,
                "orderCustomerPhoneNumber": orderCustomerPhoneNumber,
                "orderCustomerPhoneNumberNotification": orderCustomerPhoneNumberNotification,
                "orderCustomerAddress": orderCustomerAddress,
                "orderCustomerEmailAddress": orderCustomerEmailAddress,
                "orderItems": orderItems,
                "orderNote": orderNote,
                "orderSubtotal": orderSubtotal,
                "orderTaxes": orderTaxes,
                "orderTotal": orderTotal,
                "orderType": orderType,
                "orderScheduleDateYYYYMMDD": orderScheduleDateYYYYMMDD,
                "orderScheduleTimeHHMM": orderScheduleTimeHHMM,
                "orderRewardDollarsRedeemed": orderRewardDollarsRedeemed,
                "orderAuthenticatedCustomerUserId": orderAuthenticatedCustomerUserId,
                "orderIsVerified": false,
                "orderHandlingFee": orderHandlingFee,
                "orderDeliveryFee": orderDeliveryFee,
                "orderOnlinePaymentEnforced": orderOnlinePaymentEnforced,
                "orderCreatedAt": orderCreatedAt,
                "orderUpdatedAt": orderCreatedAt,
                "woo": appConstants.ONLINE_ORDER_STATUS_HASH,
                "ttl": orderOnlinePaymentEnforced ? Math.floor(orderCreatedAt / 1000) + appConstants.ONE_30_DAYS : Math.floor(orderCreatedAt / 1000) + 5 * appConstants.ONE_YEAR
            },
        };
        const command = new PutCommand(params);
        await dynamoDbDocumentClient.send(command);
        return {
            "orderId": orderId,
            "orderCode": orderCode,
            "orderOnlinePaymentEnforced": orderOnlinePaymentEnforced
        };
    } catch (e) {
        console.error("In submitOnlineOrder", e);
        throw "Could not submitOnlineOrder";
    }
}

////////////////////////////////////////
// Get Website Online Orders
////////////////////////////////////////
export async function getWebsiteOnlineOrders(
    websiteId: any,
) {
    try {
        let onlineOrders: any[] = [];
        let lastEvaluatedKey;

        do {
            const command: QueryCommand = new QueryCommand({
                TableName: DEFAULT_TABLE_NAME,
                IndexName: appConstants.INDEX_NAME_WEBSITE_ONLINE_ORDER_STATUS_GSI,
                KeyConditionExpression: "#pk = :pk and begins_with(#orderStatus, :orderStatus_prefix)",
                ExpressionAttributeNames: {
                    "#pk": "pk",
                    "#orderStatus": "orderStatus"
                },
                ExpressionAttributeValues: {
                    ":pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                    ":orderStatus_prefix": appConstants.ONLINE_ORDER_STATUS_NOT_DELIVERED_PREFIX
                },
                ScanIndexForward: false,
                ExclusiveStartKey: lastEvaluatedKey
            });

            const result = await dynamoDbDocumentClient.send(command);
            onlineOrders = onlineOrders.concat(result.Items);

            // Update the lastEvaluatedKey to paginate if more data is available
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey); // Continue fetching data until there's no more

        // Purify
        for (let onlineOrder of onlineOrders) {
            delete onlineOrder["pk"];
            delete onlineOrder["sk"];
            delete onlineOrder["ttl"];
        }

        return onlineOrders;
    } catch (e) {
        console.error("In getWebsiteOnlineOrders", e);
        throw "Could not getWebsiteOnlineOrders";
    }
}

////////////////////////////////////////
// Get Website Online Orders
////////////////////////////////////////
export async function calcWebsiteOrdersOnlinePaymentAmountPaidCents(
    onlineOrders: any[],
) {
    try {
        await Promise.all(
            onlineOrders.map(async (onlineOrder) => {
                if (onlineOrder.orderOnlinePaymentEnforced === true) { // Calculate total amount paid
                    let totalAmountChargedOnlineCents: number = 0;
                    let totalAmountChargedInPersonCents: number = 0;

                    // Run all async calls concurrently
                    const [
                        orderPaymentIntents,
                        orderRefundedCharges,
                        orderPaymentsHandledInPerson,
                    ] = await Promise.all([
                        wooGetOrderPaymentIntents(onlineOrder.orderWebsiteId, onlineOrder.orderId) as Promise<OrderOnlinePaymentIntentSucceeded[]>,
                        wooGetOrderRefundedCharges(onlineOrder.orderWebsiteId, onlineOrder.orderId),
                        wooGetOrderPaymentsHandledInPerson(onlineOrder.orderWebsiteId, onlineOrder.orderId),
                    ]);

                    // Payment Intents
                    for (let orderPaymentIntent of orderPaymentIntents) {
                        totalAmountChargedOnlineCents += orderPaymentIntent.amount;
                    }

                    // Refunded Charges
                    for (let orderRefundedCharge of orderRefundedCharges) {
                        totalAmountChargedOnlineCents -= orderRefundedCharge.amountRefunded;
                    }

                    // Payments Handled In-Person
                    for (let orderPaymentHandledInPerson of orderPaymentsHandledInPerson) {
                        totalAmountChargedInPersonCents += orderPaymentHandledInPerson.amount;
                    }

                    // Set amount paid
                    onlineOrder["orderOnlinePaymentAmountPaidOnlineCents"] = totalAmountChargedOnlineCents;
                    onlineOrder["orderOnlinePaymentAmountPaidInPersonCents"] = totalAmountChargedInPersonCents;
                } else { // Amount paid not applicable
                    onlineOrder["orderOnlinePaymentAmountPaidOnlineCents"] = 0;
                    onlineOrder["orderOnlinePaymentAmountPaidInPersonCents"] = 0;
                }
            })
        );
    } catch (e) {
        console.error("In calcWebsiteOrdersOnlinePaymentAmountPaidCents", e);
        throw "Could not calcWebsiteOrdersOnlinePaymentAmountPaidCents";
    }
}

////////////////////////////////////////
// Get Website Online Orders
////////////////////////////////////////
export async function getLostOnlineOrders() {
    try {
        let onlineOrders: any[] = [];
        let lastEvaluatedKey;

        do {
            const command: QueryCommand = new QueryCommand({
                TableName: DEFAULT_TABLE_NAME,
                IndexName: appConstants.INDEX_NAME_WEBSITE_ONLINE_ORDER_STATUS_STRICT_GSI,
                KeyConditionExpression: "#woo = :woo and begins_with(#orderStatus, :orderStatus_prefix)",
                ExpressionAttributeNames: {
                    "#woo": "woo",
                    "#orderStatus": "orderStatus"
                },
                ExpressionAttributeValues: {
                    ":woo": appConstants.ONLINE_ORDER_STATUS_HASH,
                    ":orderStatus_prefix": appConstants.ONLINE_ORDER_STATUS_NOT_DELIVERED_PREFIX + "#" + appConstants.ONLINE_ORDER_STATUS_NOT_ACKNOWLEDGED + "#"
                },
                ScanIndexForward: false,
                ExclusiveStartKey: lastEvaluatedKey
            });

            const result = await dynamoDbDocumentClient.send(command);
            onlineOrders = onlineOrders.concat(result.Items);

            // Update the lastEvaluatedKey to paginate if more data is available
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey); // Continue fetching data until there's no more

        // Purify
        for (let onlineOrder of onlineOrders) {
            delete onlineOrder["pk"];
            delete onlineOrder["sk"];
            delete onlineOrder["ttl"];
        }

        return onlineOrders;
    } catch (e) {
        console.error("In getLostOnlineOrders", e);
        throw "Could not getLostOnlineOrders";
    }
}

////////////////////////////////////////
// Get Website Online Order
////////////////////////////////////////
export async function getWebsiteOnlineOrder(
    websiteId: any, 
    orderId: any,
) {
    try {
        const command = new GetCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId,
            }
        });
        const onlineOrder = (await dynamoDbDocumentClient.send(command)).Item;
        if (onlineOrder) {
            delete onlineOrder["pk"];
            delete onlineOrder["sk"];
            delete onlineOrder["ttl"];
        }
        return onlineOrder;
    } catch (e) {
        console.error("In getWebsiteOnlineOrder", e);
        throw "Could not getWebsiteOnlineOrder";
    }
}

////////////////////////////////////////
// Get Website Online Orders
////////////////////////////////////////
export async function getWebsiteOnlineOrdersArchive(
    websiteId: any, 
    lastEvaluatedOrderId: any = null, 
    lastEvaluatedUpdatedAt: any = null
) {
    try {
        const params: any = {
            TableName: DEFAULT_TABLE_NAME,
            IndexName: appConstants.INDEX_NAME_WEBSITE_ONLINE_ORDER_STATUS_GSI,
            KeyConditionExpression: "#pk = :pk and begins_with(#orderStatus, :orderStatus_prefix)",
            ExpressionAttributeNames: {
                "#pk": "pk",
                "#orderStatus": "orderStatus"
            },
            ExpressionAttributeValues: {
                ":pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                ":orderStatus_prefix": appConstants.ONLINE_ORDER_STATUS_DELIVERED_PREFIX + "#" + appConstants.ONLINE_ORDER_STATUS_COMPLETED + "#"
            },
            Limit: 15,
            ScanIndexForward: false,
        };
        if (lastEvaluatedOrderId && lastEvaluatedUpdatedAt) {
            params["ExclusiveStartKey"] = {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + lastEvaluatedOrderId,
                "orderStatus": appConstants.ONLINE_ORDER_STATUS_DELIVERED_PREFIX + "#" + appConstants.ONLINE_ORDER_STATUS_COMPLETED + "#" + lastEvaluatedUpdatedAt
            };
        }

        const result = await dynamoDbDocumentClient.send(new QueryCommand(params));
        const onlineOrders: any = result.Items;

        // Purify
        const websiteInfo: any = await getWebsiteInfo(websiteId);
        const timeZoneId = websiteInfo.websiteTimezoneData.timeZoneId;
        for (let onlineOrder of onlineOrders) {
            onlineOrder["orderUpdatedAtLocal"] = getLocalizedTimestamp(onlineOrder["orderUpdatedAt"], timeZoneId);
            onlineOrder["orderUpdatedAtLocalStr"] = getLocalizedDate(onlineOrder["orderUpdatedAt"], timeZoneId);
            delete onlineOrder["pk"];
            delete onlineOrder["sk"];
            delete onlineOrder["ttl"];
        }

        // Calculate amount paid for all order
        await calcWebsiteOrdersOnlinePaymentAmountPaidCents(onlineOrders);

        return {
            "websiteOnlineOrders": onlineOrders,
            "lastEvaluatedUpdatedAt": result.LastEvaluatedKey ? Number(result.LastEvaluatedKey["orderStatus"].split("#")[2]) : undefined, // timestamp epoch
        };
    } catch (e) {
        console.error("In getWebsiteOnlineOrdersArchive", e);
        throw "Could not getWebsiteOnlineOrdersArchive";
    }
}

////////////////////////////////////////
// Get Website Online Orders Date Range
////////////////////////////////////////
export async function getWebsiteCompletedOnlineOrders(
    websiteId: any, 
    startTimestamp: any, 
    endTimestamp: any,
) {
    try {
        let onlineOrders: any = [];
        let lastEvaluatedKey;

        do {
            const command: QueryCommand = new QueryCommand({
                TableName: DEFAULT_TABLE_NAME,
                IndexName: appConstants.INDEX_NAME_WEBSITE_ONLINE_ORDER_STATUS_GSI,
                KeyConditionExpression: "#pk = :pk AND #orderStatus BETWEEN :orderStatus_prefix_start AND :orderStatus_prefix_end",
                ExpressionAttributeNames: {
                    "#pk": "pk",
                    "#orderStatus": "orderStatus"
                },
                ExpressionAttributeValues: {
                    ":pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                    ":orderStatus_prefix_start": appConstants.ONLINE_ORDER_STATUS_DELIVERED_PREFIX + "#" + appConstants.ONLINE_ORDER_STATUS_COMPLETED + "#" + startTimestamp,
                    ":orderStatus_prefix_end": appConstants.ONLINE_ORDER_STATUS_DELIVERED_PREFIX + "#" + appConstants.ONLINE_ORDER_STATUS_COMPLETED + "#" + endTimestamp
                },
                ScanIndexForward: false,
                ExclusiveStartKey: lastEvaluatedKey
            });

            const result = await dynamoDbDocumentClient.send(command);
            onlineOrders = onlineOrders.concat(result.Items);

            // Update the lastEvaluatedKey to paginate if more data is available
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey); // Continue fetching data until there's no more

        // Purify
        for (let onlineOrder of onlineOrders) {
            delete onlineOrder["pk"];
            delete onlineOrder["sk"];
            delete onlineOrder["ttl"];
        }

        return onlineOrders;
    } catch (e) {
        console.error("In getWebsiteCompletedOnlineOrders", e);
        throw "Could not getWebsiteCompletedOnlineOrders";
    }
}

////////////////////////////////////////
// Acknowledge Order
////////////////////////////////////////
export async function wooAcknowledgeOrder(
    orderWebsiteId: any, 
    orderId: any, 
    orderLastUpdatedAt: any
) {
    try {
        const command = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + orderWebsiteId,
                "sk": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #orderStatus = :orderStatus, #orderUpdatedAt = :orderUpdatedAt",
            ExpressionAttributeNames: {
                '#orderStatus': 'orderStatus',
                '#orderUpdatedAt': 'orderUpdatedAt',
            },
            ExpressionAttributeValues: {
                ":orderStatus": appConstants.ONLINE_ORDER_STATUS_NOT_DELIVERED_PREFIX + "#" + appConstants.ONLINE_ORDER_STATUS_ACKNOWLEDGED + "#" + orderLastUpdatedAt,
                ":orderUpdatedAt": orderLastUpdatedAt,
            },
        });
        await dynamoDbDocumentClient.send(command);
        return orderLastUpdatedAt;
    } catch (e) {
        console.error("In wooAcknowledgeOrder", e);
        throw "Could not wooAcknowledgeOrder";
    }
}

////////////////////////////////////////
// Reject Order
////////////////////////////////////////
export async function wooRejectOrder(
    orderWebsiteId: any, 
    orderId: any,
) {
    try {
        const updatedAt = Date.now();
        const command = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + orderWebsiteId,
                "sk": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #orderStatus = :orderStatus, #orderUpdatedAt = :orderUpdatedAt",
            ExpressionAttributeNames: {
                '#orderStatus': 'orderStatus',
                '#orderUpdatedAt': 'orderUpdatedAt',
            },
            ExpressionAttributeValues: {
                ":orderStatus": appConstants.ONLINE_ORDER_STATUS_DELIVERED_PREFIX + "#" + appConstants.ONLINE_ORDER_STATUS_REJECTED + "#" + updatedAt,
                ":orderUpdatedAt": updatedAt,
            },
        });
        await dynamoDbDocumentClient.send(command);
        return updatedAt;
    } catch (e) {
        console.error("In wooRejectOrder", e);
        throw "Could not wooRejectOrder";
    }
}

////////////////////////////////////////
// Verify Order
////////////////////////////////////////
export async function wooVerifyOrder(
    orderWebsiteId: any, 
    orderId: any,
) {
    try {
        const command = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + orderWebsiteId,
                "sk": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #orderIsVerified = :orderIsVerified",
            ExpressionAttributeNames: {
                '#orderIsVerified': 'orderIsVerified',
            },
            ExpressionAttributeValues: {
                ":orderIsVerified": true,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In wooVerifyOrder", e);
        throw "Could not wooVerifyOrder";
    }
}

////////////////////////////////////////
// Confirm Order
////////////////////////////////////////
export async function wooConfirmOrder(
    orderWebsiteId: any, 
    orderId: any, 
    orderWaitingTimeMins: any, 
    orderConfirmedAt: any,
) {
    try {
        const updatedAt = Date.now();
        const command = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + orderWebsiteId,
                "sk": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #orderStatus = :orderStatus, #orderWaitingTimeMins = :orderWaitingTimeMins, #orderConfirmedAt = :orderConfirmedAt, #orderUpdatedAt = :orderUpdatedAt",
            ExpressionAttributeNames: {
                '#orderStatus': 'orderStatus',
                '#orderWaitingTimeMins': 'orderWaitingTimeMins',
                '#orderConfirmedAt': 'orderConfirmedAt',
                '#orderUpdatedAt': 'orderUpdatedAt',
            },
            ExpressionAttributeValues: {
                ":orderStatus": appConstants.ONLINE_ORDER_STATUS_NOT_DELIVERED_PREFIX + "#" + appConstants.ONLINE_ORDER_STATUS_PREPARING + "#" + updatedAt,
                ":orderWaitingTimeMins": orderWaitingTimeMins,
                ":orderConfirmedAt": orderConfirmedAt,
                ":orderUpdatedAt": updatedAt,
            },
        });
        await dynamoDbDocumentClient.send(command);
        return updatedAt;
    } catch (e) {
        console.error("In wooConfirmOrder", e);
        throw "Could not wooConfirmOrder";
    }
}

////////////////////////////////////////
// Mark Order Ready
////////////////////////////////////////
export async function wooMarkOrderReady(
    orderWebsiteId: any, 
    orderId: any, 
    orderLastUpdatedAt: any
) {
    try {
        const updatedAt = Date.now();
        const command = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + orderWebsiteId,
                "sk": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #orderStatus = :orderStatus, #orderUpdatedAt = :orderUpdatedAt",
            ExpressionAttributeNames: {
                '#orderStatus': 'orderStatus',
                '#orderUpdatedAt': 'orderUpdatedAt',
            },
            ExpressionAttributeValues: {
                ":orderStatus": appConstants.ONLINE_ORDER_STATUS_NOT_DELIVERED_PREFIX + "#" + appConstants.ONLINE_ORDER_STATUS_READY + "#" + updatedAt,
                ":orderUpdatedAt": updatedAt,
            },
        });
        await dynamoDbDocumentClient.send(command);
        return updatedAt;
    } catch (e) {
        console.error("In wooMarkOrderReady", e);
        throw "Could not wooMarkOrderReady";
    }
}

////////////////////////////////////////
// Move Order To Archive
////////////////////////////////////////
export async function wooMoveOrderToArchive(
    orderWebsiteId: any, 
    orderId: any, 
    orderLastUpdatedAt: any
) {
    try {
        const updatedAt = Date.now();
        const command = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + orderWebsiteId,
                "sk": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #orderStatus = :orderStatus, #orderUpdatedAt = :orderUpdatedAt",
            ExpressionAttributeNames: {
                '#orderStatus': 'orderStatus',
                '#orderUpdatedAt': 'orderUpdatedAt',
            },
            ExpressionAttributeValues: {
                ":orderStatus": appConstants.ONLINE_ORDER_STATUS_DELIVERED_PREFIX + "#" + appConstants.ONLINE_ORDER_STATUS_COMPLETED + "#" + updatedAt,
                ":orderUpdatedAt": updatedAt,
            },
        });
        await dynamoDbDocumentClient.send(command);
        return updatedAt;
    } catch (e) {
        console.error("In wooMoveOrderToArchive", e);
        throw "Could not wooMoveOrderToArchive";
    }
}

////////////////////////////////////////
// Update order with payment session completed
////////////////////////////////////////
export async function wooUpdateOrderPaymentSessionCompleted(
    orderWebsiteId: string,
    sessionData: OrderOnlinePaymentSessionCompleted
) {
    try {
        const createdAt: number = Date.now();
        await dynamoDbDocumentClient.send(new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                pk: appConstants.DYNAMO_ENTITY_WEBSITE + "#" + orderWebsiteId,
                sk: appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + sessionData.metadata.orderId + "#" + appConstants.DYNAMO_ENTITY_ONLINE_ORDER_PAYMENT_SESSION + "#" + sessionData.id,
            },
            UpdateExpression: `
                SET 
                #paymentIntentId = :paymentIntentId, 
                #amountTotal = :amountTotal, 
                #currency = :currency, 
                #paymentStatus = :paymentStatus, 
                #metadata = :metadata,
                #createdAt = :createdAt,
                #ttl = :ttl`,
            ExpressionAttributeNames: {
                "#paymentIntentId": "paymentIntentId",
                "#amountTotal": "amountTotal",
                "#currency": "currency",
                "#paymentStatus": "paymentStatus",
                "#metadata": "metadata",
                "#createdAt": "createdAt",
                "#ttl": "ttl",
            },
            ExpressionAttributeValues: {
                ":paymentIntentId": sessionData.paymentIntentId,
                ":amountTotal": sessionData.amountTotal,
                ":currency": sessionData.currency,
                ":paymentStatus": sessionData.paymentStatus,
                ":metadata": sessionData.metadata,
                ":createdAt": createdAt,
                ":ttl": Math.floor(createdAt / 1000) + 5 * appConstants.ONE_YEAR
            },
        }));
    } catch (e) {
        console.error("In wooUpdateOrderPaymentSessionCompleted", e);
        throw "Could not wooUpdateOrderPaymentSessionCompleted";
    }
}

////////////////////////////////////////
// Update order with payment intent
////////////////////////////////////////
export async function wooUpdateOrderPaymentIntentSucceeded(
    orderWebsiteId: string,
    intentData: OrderOnlinePaymentIntentSucceeded
) {
    try {
        // Fetch existing order if any
        const onlineOrder: any = await getWebsiteOnlineOrder(orderWebsiteId, intentData.metadata.orderId);

        // Update order item
        const orderUpdatedAt: number = Date.now();
        const result = await dynamoDbDocumentClient.send(new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                pk: appConstants.DYNAMO_ENTITY_WEBSITE + "#" + orderWebsiteId,
                sk: appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + intentData.metadata.orderId,
            },
            UpdateExpression: `
                SET 
                #orderStatus = :orderStatus,
                #orderUpdatedAt = :updatedAt,
                #ttl = :ttl
              `,
            ExpressionAttributeNames: {
                "#orderStatus": "orderStatus",
                "#orderUpdatedAt": "orderUpdatedAt",
                "#ttl": "ttl",
            },
            ExpressionAttributeValues: {
                ":orderStatus": onlineOrder.orderStatus.split("#")[0] === appConstants.ONLINE_ORDER_STATUS_PENDING_ONLINE_PAYMENT ? appConstants.ONLINE_ORDER_STATUS_NOT_DELIVERED_PREFIX + "#" + appConstants.ONLINE_ORDER_STATUS_NOT_ACKNOWLEDGED + "#" + orderUpdatedAt : onlineOrder.orderStatus,
                ":updatedAt": orderUpdatedAt,
                ":ttl": Math.floor(orderUpdatedAt / 1000) + 5 * appConstants.ONE_YEAR
            },
            ReturnValues: "ALL_NEW",
        }));

        // Update payment intent
        await dynamoDbDocumentClient.send(new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                pk: appConstants.DYNAMO_ENTITY_WEBSITE + "#" + orderWebsiteId,
                sk: appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + intentData.metadata.orderId + "#" + appConstants.DYNAMO_ENTITY_ONLINE_ORDER_PAYMENT_INTENT + "#" + intentData.id,
            },
            UpdateExpression: `
                SET 
                #status = :status, 
                #amount = :amount, 
                #currency = :currency, 
                #metadata = :metadata,
                #createdAt = :createdAt,
                #ttl = :ttl`,
            ExpressionAttributeNames: {
                "#status": "status",
                "#amount": "amount",
                "#currency": "currency",
                "#metadata": "metadata",
                "#createdAt": "createdAt",
                "#ttl": "ttl",
            },
            ExpressionAttributeValues: {
                ":status": intentData.status,
                ":amount": intentData.amount,
                ":currency": intentData.currency,
                ":metadata": intentData.metadata,
                ":createdAt": orderUpdatedAt,
                ":ttl": Math.floor(orderUpdatedAt / 1000) + 5 * appConstants.ONE_YEAR
            },
        }));

        dqs.enqueue({
            topicId: appConstants.SQS_MESSAGE_TOPIC_ID_WOO_NOTIFY_TEAM_MEMBERS,
            data: {
                "websiteId": orderWebsiteId,
                "notificationType": appConstants.USER_NTF_ORDER_GENERAL_UPDATE,
                "title": `Order Payment Completed (${intentData.metadata.orderId})`,
                "body": result.Attributes?.orderWebsiteBusinessName ?? "NA",
            }
        });
    } catch (e) {
        console.error("In wooUpdateOrderPaymentIntentSucceeded", e);
        throw "Could not wooUpdateOrderPaymentIntentSucceeded";
    }
}

////////////////////////////////////////
// Update order with charge refunded
////////////////////////////////////////
export async function wooUpdateOrderRefundedCharge(
    stripe: Stripe,
    orderWebsiteId: string,
    refundedCharge: OrderOnlinePaymentRefundedCharge
) {
    try {
        // Determine orderId
        let orderId: string;
        if (refundedCharge.intentId.length > 0) {
            const pi = await stripe.paymentIntents.retrieve(
                refundedCharge.intentId
            );
            orderId = pi.metadata.orderId;
        } else {
            // intentId === '' means charge was placed manually on Stripe outside the system, ignore.
            return;
        }

        // Update Refunded Charge
        const orderUpdatedAt: number = Date.now();
        await dynamoDbDocumentClient.send(new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                pk: appConstants.DYNAMO_ENTITY_WEBSITE + "#" + orderWebsiteId,
                sk: appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId + "#" + appConstants.DYNAMO_ENTITY_ONLINE_ORDER_REFUNDED_CHARGE + "#" + refundedCharge.id,
            },
            UpdateExpression: `
                    SET 
                    #intentId = :intentId, 
                    #amountRefunded = :amountRefunded, 
                    #ttl = :ttl
                `,
            ExpressionAttributeNames: {
                "#intentId": "intentId",
                "#amountRefunded": "amountRefunded",
                "#ttl": "ttl",
            },
            ExpressionAttributeValues: {
                ":intentId": refundedCharge.intentId,
                ":amountRefunded": refundedCharge.amountRefunded,
                ":ttl": Math.floor(orderUpdatedAt / 1000) + 5 * appConstants.ONE_YEAR
            },
        }));

        dqs.enqueue({
            topicId: appConstants.SQS_MESSAGE_TOPIC_ID_WOO_NOTIFY_TEAM_MEMBERS,
            data: {
                "websiteId": orderWebsiteId,
                "notificationType": appConstants.USER_NTF_ORDER_GENERAL_UPDATE,
                "title": `Order Charge Refunded (${orderId})`,
                "body": "Refund Issued",
            }
        });
    } catch (e) {
        console.error("In wooUpdateOrderRefundedCharge", e);
        throw "Could not wooUpdateOrderRefundedCharge";
    }
}


////////////////////////////////////////
// Update order with in-person payment
////////////////////////////////////////
export async function wooUpdateOrderPaymentInPerson(
    orderWebsiteId: string,
    orderId: string,
    extraAmountPaidCents: number,
) {
    try {
        const actionId = ULID.ulid();
        const orderUpdatedAt: number = Date.now();
        await dynamoDbDocumentClient.send(new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                pk: appConstants.DYNAMO_ENTITY_WEBSITE + "#" + orderWebsiteId,
                sk: appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId + "#" + appConstants.DYNAMO_ENTITY_ONLINE_ORDER_PAYMENT_HANDLED_IN_PERSON + "#" + actionId,
            },
            UpdateExpression: `
                SET 
                #amount = :amount, 
                #createdAt = :createdAt,
                #ttl = :ttl`,
            ExpressionAttributeNames: {
                "#amount": "amount",
                "#createdAt": "createdAt",
                "#ttl": "ttl",
            },
            ExpressionAttributeValues: {
                ":amount": extraAmountPaidCents,
                ":createdAt": orderUpdatedAt,
                ":ttl": Math.floor(orderUpdatedAt / 1000) + 5 * appConstants.ONE_YEAR
            },
        }));
    } catch (e) {
        console.error("In wooUpdateOrderPaymentInPerson", e);
        throw "Could not wooUpdateOrderPaymentInPerson";
    }
}

////////////////////////////////////////
// Adjust order total
////////////////////////////////////////
export async function adjustOrderTotal(
    websiteId: any, 
    orderId: any, 
    adjustmentValue: any,
) {
    try {
        const command = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "ADD orderTotal :inc",
            ExpressionAttributeValues: {
                ":inc": adjustmentValue,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In website->adjustOrderTotal", e);
        throw "Could not adjust order total";
    }
}

////////////////////////////////////////
// Update Online Order item Misc Note
////////////////////////////////////////
export async function wooUpdateItemMiscNote(
    orderWebsiteId: any, 
    orderId: any, 
    orderItemId: any, 
    miscNote: any,
) {
    try {
        const command = new GetCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + orderWebsiteId,
                "sk": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId,
            }
        });
        const onlineOrder = (await dynamoDbDocumentClient.send(command)).Item;
        if (!onlineOrder) {
            throw "Online order not found";
        }
        let foundOrderItem = false;
        let amountToAddToTotal = 0;
        let oldItemMiscNote;
        for (let item of onlineOrder["orderItems"]) {
            if (item["uniqueId"] === orderItemId) {
                foundOrderItem = true;
                if (item["miscNote"]) {
                    oldItemMiscNote = JSON.parse(JSON.stringify(item["miscNote"]));
                }
                item["miscNote"] = miscNote;
                let totalTaxPercentage = 0;
                for (let tax of item["taxes"]) {
                    totalTaxPercentage += Number(tax["percentage"]);
                }
                amountToAddToTotal = (Number(miscNote["price"]) - (oldItemMiscNote ? Number(oldItemMiscNote["price"]) : 0)) * ((totalTaxPercentage + 100) / 100)
                break;
            }
        }
        if (!foundOrderItem) {
            throw "Online order item not found";
        }

        // Update misc note
        const updateCommand = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + orderWebsiteId,
                "sk": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #orderItems = :orderItems",
            ExpressionAttributeNames: {
                '#orderItems': 'orderItems',
            },
            ExpressionAttributeValues: {
                ":orderItems": onlineOrder["orderItems"],
            },
        });
        await dynamoDbDocumentClient.send(updateCommand);

        // Update order total
        if (amountToAddToTotal !== 0) {
            await adjustOrderTotal(orderWebsiteId, orderId, amountToAddToTotal);
        }

    } catch (e) {
        console.error("In wooUpdateItemMiscNote", e);
        throw "Could not wooUpdateItemMiscNote";
    }
}

////////////////////////////////////////
// Update Online Order Misc Note
////////////////////////////////////////
export async function wooUpdatemMiscNote(
    orderWebsiteId: any, 
    orderId: any, 
    miscNote: any,
) {
    try {
        // Get previous state
        const command = new GetCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + orderWebsiteId,
                "sk": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId,
            }
        });
        const onlineOrder = (await dynamoDbDocumentClient.send(command)).Item;
        if (!onlineOrder) {
            throw "Online order not found";
        }
        let oldMiscNote;
        if (onlineOrder["miscNote"]) {
            oldMiscNote = JSON.parse(JSON.stringify(onlineOrder["miscNote"]));
        }

        // Update misc note
        const updateCommand = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + orderWebsiteId,
                "sk": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #miscNote = :miscNote",
            ExpressionAttributeNames: {
                '#miscNote': 'miscNote',
            },
            ExpressionAttributeValues: {
                ":miscNote": miscNote,
            },
        });
        await dynamoDbDocumentClient.send(updateCommand);

        // Update order total
        const amountToAddToTotal = Number(miscNote["price"]) - (oldMiscNote ? Number(oldMiscNote["price"]) : 0);
        if (amountToAddToTotal !== 0) {
            await adjustOrderTotal(orderWebsiteId, orderId, amountToAddToTotal);
        }
    } catch (e) {
        console.error("In wooUpdatemMiscNote", e);
        throw "Could not wooUpdatemMiscNote";
    }
}

////////////////////////////////////////
// Query Order Payment Intents
////////////////////////////////////////
export async function wooGetOrderPaymentIntents(
    websiteId: string,
    orderId: string,
    isStrict: boolean = false,
): Promise<OrderOnlinePaymentIntentSucceeded[] | string[]> {
    try {
        let resultItems: any[] = [];
        let lastEvaluatedKey;

        do {
            const command: QueryCommand = new QueryCommand({
                TableName: DEFAULT_TABLE_NAME,
                KeyConditionExpression: "#pk = :pk and begins_with(#sk, :sk_prefix)",
                ExpressionAttributeNames: {
                    "#pk": "pk",
                    "#sk": "sk",
                },
                ExpressionAttributeValues: {
                    ":pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                    ":sk_prefix": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId + "#" + appConstants.DYNAMO_ENTITY_ONLINE_ORDER_PAYMENT_INTENT + "#",
                },
                ExclusiveStartKey: lastEvaluatedKey // for pagination
            });

            const result = await dynamoDbDocumentClient.send(command);
            resultItems = resultItems.concat(result.Items as any[]);

            // Update the lastEvaluatedKey to paginate if more data is available
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey); // Continue fetching data until there's no more

        if (isStrict) {
            return resultItems.map((item) => item.sk.split("#")[3]);
        } else {
            const orderPaymentIntents: OrderOnlinePaymentIntentSucceeded[] = []
            for (let item of resultItems) {
                orderPaymentIntents.push({
                    id: item.sk.split("#")[3],
                    status: item.status,
                    amount: item.amount,
                    currency: item.currency,
                    metadata: item.metadata,
                })
            }
            return orderPaymentIntents;
        }
    } catch (e) {
        console.error("In wooGetOrderPaymentIntents", e);
        throw "Could not wooGetOrderPaymentIntents";
    }
}

////////////////////////////////////////
// Query Order Payment Intents
////////////////////////////////////////
export async function wooGetOrderRefundedCharges(
    websiteId: string,
    orderId: string,
): Promise<OrderOnlinePaymentRefundedCharge[]> {
    try {
        let resultItems: any[] = [];
        let lastEvaluatedKey;

        do {
            const command: QueryCommand = new QueryCommand({
                TableName: DEFAULT_TABLE_NAME,
                KeyConditionExpression: "#pk = :pk and begins_with(#sk, :sk_prefix)",
                ExpressionAttributeNames: {
                    "#pk": "pk",
                    "#sk": "sk",
                },
                ExpressionAttributeValues: {
                    ":pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                    ":sk_prefix": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId + "#" + appConstants.DYNAMO_ENTITY_ONLINE_ORDER_REFUNDED_CHARGE + "#",
                },
                ExclusiveStartKey: lastEvaluatedKey // for pagination
            });

            const result = await dynamoDbDocumentClient.send(command);
            resultItems = resultItems.concat(result.Items as any[]);

            // Update the lastEvaluatedKey to paginate if more data is available
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey); // Continue fetching data until there's no more

        const orderRefundedCharges: OrderOnlinePaymentRefundedCharge[] = []
        for (let item of resultItems) {
            orderRefundedCharges.push({
                id: item.sk.split("#")[3],
                intentId: item.intentId,
                amountRefunded: item.amountRefunded,
            })
        }
        return orderRefundedCharges;
    } catch (e) {
        console.error("In wooGetOrderRefundedCharges", e);
        throw "Could not wooGetOrderRefundedCharges";
    }
}

////////////////////////////////////////
// Query Order Payments Handled In Person
////////////////////////////////////////
export async function wooGetOrderPaymentsHandledInPerson(
    websiteId: string,
    orderId: string,
): Promise<OrderOnlinePaymentHandledPerson[]> {
    try {
        let resultItems: any[] = [];
        let lastEvaluatedKey;

        do {
            const command: QueryCommand = new QueryCommand({
                TableName: DEFAULT_TABLE_NAME,
                KeyConditionExpression: "#pk = :pk and begins_with(#sk, :sk_prefix)",
                ExpressionAttributeNames: {
                    "#pk": "pk",
                    "#sk": "sk",
                },
                ExpressionAttributeValues: {
                    ":pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                    ":sk_prefix": appConstants.DYNAMO_ENTITY_ONLINE_ORDER + "#" + orderId + "#" + appConstants.DYNAMO_ENTITY_ONLINE_ORDER_PAYMENT_HANDLED_IN_PERSON + "#",
                },
                ExclusiveStartKey: lastEvaluatedKey // for pagination
            });

            const result = await dynamoDbDocumentClient.send(command);
            resultItems = resultItems.concat(result.Items as any[]);

            // Update the lastEvaluatedKey to paginate if more data is available
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey); // Continue fetching data until there's no more

        const orderPaymentsHandledInPerson: OrderOnlinePaymentHandledPerson[] = []
        for (let item of resultItems) {
            orderPaymentsHandledInPerson.push({
                id: item.sk.split("#")[3],
                amount: item.amount,
            })
        }
        return orderPaymentsHandledInPerson;
    } catch (e) {
        console.error("In wooGetOrderPaymentsHandledInPerson", e);
        throw "Could not wooGetOrderPaymentsHandledInPerson";
    }
}

////////////////////////////////////////
// Adjust website counter
////////////////////////////////////////
export async function incCounter(
    websiteId: any, 
    counterName: any, 
    adjustmentValue: number = 1, 
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        const command = new UpdateCommand({
            TableName: tableName,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_APP + "#" + appConstants.DYNAMO_ENTITY_WEBSITE,
                "sk": appConstants.DYNAMO_ENTITY_INFO + "#" + websiteId
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "ADD " + counterName + " :inc",
            ExpressionAttributeValues: {
                ":inc": adjustmentValue,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In website->incCounter", e);
        throw "Could not adjust website counters";
    }
}

////////////////////////////////////////
// Register Website Heartbeat
////////////////////////////////////////
export async function registerHeartbeat(
    websiteId: any, 
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        const command = new UpdateCommand({
            TableName: tableName,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_APP + "#" + appConstants.DYNAMO_ENTITY_WEBSITE,
                "sk": appConstants.DYNAMO_ENTITY_INFO + "#" + websiteId
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #websiteLastheartbeatTimestamp = :websiteLastheartbeatTimestamp",
            ExpressionAttributeNames: {
                "#websiteLastheartbeatTimestamp": "websiteLastheartbeatTimestamp",
            },
            ExpressionAttributeValues: {
                ":websiteLastheartbeatTimestamp": Date.now(),
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In website->registerHeartbeat", e);
        throw "Could not register website heartbeat";
    }
}

////////////////////////////////////////
// Create website invoice record
////////////////////////////////////////
export async function createWebsiteInvoiceRecord(
    userId: any, 
    websiteId: any, 
    invoiceId: any, 
    invoiceData: any,
    ) {
    try {
        const command = new PutCommand({
            TableName: DEFAULT_TABLE_NAME,
            Item: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_INVOICE + "#" + invoiceId,
                "websiteInvoiceData": invoiceData,
                "websiteInvoiceIsPaymentConfirmed": false,
                "itemAncestor": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In createWebsiteInvoiceRecord", e);
        throw "Create website invoice record";
    }
}

////////////////////////////////////////
// Confirm website invoice payment
////////////////////////////////////////
export async function confirmWebsiteInvoicePayment(
    websiteId: any, 
    invoiceId: any,
    ) {
    try {
        const command = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_INVOICE + "#" + invoiceId,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #websiteInvoiceIsPaymentConfirmed = :websiteInvoiceIsPaymentConfirmed",
            ExpressionAttributeNames: {
                "#websiteInvoiceIsPaymentConfirmed": "websiteInvoiceIsPaymentConfirmed",
            },
            ExpressionAttributeValues: {
                ":websiteInvoiceIsPaymentConfirmed": true,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In confirmWebsiteInvoicePayment", e);
        throw "Could not confirmWebsiteInvoicePayment";
    }
}

////////////////////////////////////////
// Get Website Invoices
////////////////////////////////////////
export async function getWebsiteInvoiceRecords(
    websiteId: any, 
    lastEvaluatedInvoiceId: any,
    ) {
    try {
        const params: any = {
            TableName: DEFAULT_TABLE_NAME,
            KeyConditionExpression: "#pk = :pk and begins_with(#sk, :sk_prefix)",
            ExpressionAttributeNames: {
                "#pk": "pk",
                "#sk": "sk"
            },
            ExpressionAttributeValues: {
                ":pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                ":sk_prefix": appConstants.DYNAMO_ENTITY_INVOICE + "#"
            },
            Limit: 8,
            ScanIndexForward: false,
        };
        if (lastEvaluatedInvoiceId) {
            params["ExclusiveStartKey"] = {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_INVOICE + "#" + lastEvaluatedInvoiceId,
            };
        }

        const result = await dynamoDbDocumentClient.send(new QueryCommand(params));
        const websiteInvoiceRecords: any = result.Items;

        // Purify
        for (let websiteInvoiceRecord of websiteInvoiceRecords) {
            websiteInvoiceRecord["websiteInvoiceId"] = websiteInvoiceRecord["sk"].split("#")[1];
            websiteInvoiceRecord["websiteInvoiceIsPaymentConfirmed"] = websiteInvoiceRecord["websiteInvoiceIsPaymentConfirmed"];
            delete websiteInvoiceRecord["pk"];
            delete websiteInvoiceRecord["sk"];
            delete websiteInvoiceRecord["itemAncestor"];
        }

        return {
            "websiteInvoiceRecords": websiteInvoiceRecords,
            "lastEvaluatedInvoiceId": result.LastEvaluatedKey ? Number(result.LastEvaluatedKey["sk"].split("#")[1]) : undefined,
        };
    } catch (e) {
        console.error("In getWebsiteInvoiceRecords", e);
        throw "Could not getWebsiteInvoiceRecords";
    }
}

////////////////////////////////////////
// Get Website Last Invoice
////////////////////////////////////////
export async function getWebsiteLastInvoiceRecord(
    websiteId: any,
    ) {
    try {
        const params = {
            TableName: DEFAULT_TABLE_NAME,
            KeyConditionExpression: "#pk = :pk and begins_with(#sk, :sk_prefix)",
            ExpressionAttributeNames: {
                "#pk": "pk",
                "#sk": "sk"
            },
            ExpressionAttributeValues: {
                ":pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                ":sk_prefix": appConstants.DYNAMO_ENTITY_INVOICE + "#"
            },
            Limit: 1,
            ScanIndexForward: false,
        };
        const websiteInvoiceRecords: any = (await dynamoDbDocumentClient.send(new QueryCommand(params))).Items;
        return websiteInvoiceRecords.length > 0 ? websiteInvoiceRecords[0] : null;
    } catch (e) {
        console.error("In getWebsiteLastInvoiceRecord", e);
        throw "Could not getWebsiteLastInvoiceRecord";
    }
}

////////////////////////////////////////
// Get Website Invoice
////////////////////////////////////////
export async function getWebsiteInvoiceRecord(
    websiteId: any, 
    invoiceId: any,
    ) {
    try {
        const command = new GetCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_INVOICE + "#" + invoiceId,
            }
        });
        return (await dynamoDbDocumentClient.send(command)).Item;
    } catch (e) {
        console.error("In getWebsiteInvoiceRecord", e);
        throw "Could not getWebsiteInvoiceRecord";
    }
}

////////////////////////////////////////
// Delete Website Invoice
////////////////////////////////////////
export async function deleteInvoiceRecord(
    websiteId: any, 
    invoiceId: any,
    ) {
    try {
        // Delete S3 pdf
        await deleteObject(`${appConstants.S3_STORAGE_BUCKET_PREFIX}${STAGE}`, `website/${websiteId}/${appConstants.S3_FOLDER_ONLINE_ORDERING_INVOICES}/${invoiceId}.pdf`);

        // Delete in DB
        const command = new DeleteCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_INVOICE + "#" + invoiceId,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
        });
        await dynamoDbDocumentClient.send(command);

        // Apply last invoice status to website last invoice state
        const lastInvoiceRecord = await getWebsiteLastInvoiceRecord(websiteId);
        if (lastInvoiceRecord) {
            await updateWebsiteWooLastInvoiceInfo(websiteId, lastInvoiceRecord.websiteInvoiceData.invoiceMetadata["invoiceId"], lastInvoiceRecord.websiteInvoiceData.invoiceInfo["invoiceDate"], lastInvoiceRecord.websiteInvoiceData.invoiceInfo["amountDue"], typeof lastInvoiceRecord.websiteInvoiceIsPaymentConfirmed === "boolean" ? lastInvoiceRecord.websiteInvoiceIsPaymentConfirmed : false);
        } else {
            await updateWebsiteWooLastInvoiceInfo(websiteId, "NA", "-", 0, false);
        }

        return;
    } catch (e) {
        console.error("In deleteInvoiceRecord", e);
        throw "Could not deleteInvoiceRecord";
    }
}

////////////////////////////////////////
// Get Website Invoice PDF Signed URL
////////////////////////////////////////
export async function getWebsiteInvoicePdfSignedUrl(
    websiteId: any, 
    invoiceId: any,
    ) {
    try {
        return await getDownloadSignedUrl(`${appConstants.S3_STORAGE_BUCKET_PREFIX}${STAGE}`, `website/${websiteId}/${appConstants.S3_FOLDER_ONLINE_ORDERING_INVOICES}/${invoiceId}.pdf`);
    } catch (e) {
        console.error("In getWebsiteInvoicePdfSignedUrl", e);
        throw "Could not getWebsiteInvoicePdfSignedUrl";
    }
}

////////////////////////////////////////
// Check for lost orders
////////////////////////////////////////
export async function checkForLostOrders(
): Promise<void> {
    try {
        let fcmToken: any, title, body, data;
        fcmToken = await fetchUserFcmTokenByEmail(appConstants.ADMIN_CONTACT_EMAIL_ADDRESS);
        if (fcmToken?.length > 0) {
            const now = new Date();
            const datetime = now.toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' }) + ' ' +
                now.toLocaleTimeString('en-CA', { hour12: false, timeZone: 'America/Edmonton' });
            console.warn(`[${datetime}] Checking for lost orders...`);
            const nonAcknowledgedOnlineOrders: any[] = await getLostOnlineOrders();
            const lostOnlineOrders: any[] = [];
            for (let nonAcknowledgedOnlineOrder of nonAcknowledgedOnlineOrders) {
                if (Number(nonAcknowledgedOnlineOrder["orderStatus"].split("#")[2]) < Date.now() - appConstants.LOST_ONLINE_ORDER_TIMEOUT_MILLIS) {
                    lostOnlineOrders.push(nonAcknowledgedOnlineOrder);
                }
            }
            if (lostOnlineOrders.length > 0) {
                console.warn("\x1b[31m❗❗❗ ==> We have lost order! ❗❗❗\x1b[0m");
                title = "Online Orders Lost";
                body = `${lostOnlineOrders.length} online orders got lost!`;
            } else {
                return;
            }
            data = {
                event: appConstants.USER_NTF_LOST_ORDERS_UPDATE,
            };
            await sendPushNotification(fcmToken, title, body, data);
        }
    } catch (e) {
        console.error("In checkForLostOrders", e);
        throw "Could not checkForLostOrders";
    }
}