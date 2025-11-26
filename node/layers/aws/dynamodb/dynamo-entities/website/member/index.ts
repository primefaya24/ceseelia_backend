// Imports
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    DynamoDBDocumentClient,
    UpdateCommand,
    DeleteCommand,
    QueryCommand,
    PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {STAGE} from "../../../../../../config";
import {appConstants} from "../../../../../../constants";

// Initialize DynamoDB Document Client
const dynamoDbDocumentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({
        region: appConstants.DEFAULT_REGION,
    })
);

// Constants
const DEFAULT_TABLE_NAME: string | undefined = `${appConstants.DYNAMO_TABLE_PREFIX}${STAGE}`;

////////////////////////////////////////
// Get Website Members
////////////////////////////////////////
export async function getWebsiteMembers(
    websiteId: any,
    ) {
    try {
        let allMembers: any[] = [];
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
                    ":sk_prefix": appConstants.DYNAMO_ENTITY_MEMBER
                },
                ExclusiveStartKey: lastEvaluatedKey // for pagination
            });

            const result = await dynamoDbDocumentClient.send(command);
            allMembers = allMembers.concat(result.Items);

            // Update the lastEvaluatedKey to paginate if more data is available
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey); // Continue fetching data until there's no more

        // Clean results
        for (let member of allMembers) {
            delete member["pk"];
            delete member["sk"];
        }

        return allMembers;
    } catch (e) {
        console.error("In getWebsiteMembers", e);
        throw "Could not getWebsiteMembers";
    }
}

////////////////////////////////////////
// Add Website Member
////////////////////////////////////////
export async function addWebsiteMember(
    websiteId: any, 
    websiteMemberFirstName: any, 
    websiteMemberLastName: any, 
    websiteMemberUserEmail: any, 
    websiteMemberPhoneNumber: any, 
    websiteMemberSideNote: any,
    ) {
    try {
        // Create member in DB
        const createdAt = Date.now();
        const websiteMemberItem: any = {
            "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
            "sk": appConstants.DYNAMO_ENTITY_MEMBER + "#" + websiteMemberUserEmail,
            "websiteMemberFirstName": websiteMemberFirstName,
            "websiteMemberLastName": websiteMemberLastName,
            "websiteMemberStatus": appConstants.DYNAMO_ENTITY_APPROVED,
            "websiteMemberPermission": appConstants.USER_PERMISSION_MODERATOR,
            "websiteMemberUserEmail": websiteMemberUserEmail,
            "websiteMemberPhoneNumber": websiteMemberPhoneNumber,
            "websiteMemberSideNote": websiteMemberSideNote,
            "websiteMembershipLastUpdated": createdAt,
        };
        const command: PutCommand = new PutCommand({
            TableName: DEFAULT_TABLE_NAME,
            Item: websiteMemberItem,
            ConditionExpression: "attribute_not_exists(pk) and attribute_not_exists(sk)",
        });
        await dynamoDbDocumentClient.send(command);

        // Return member
        delete websiteMemberItem["pk"];
        delete websiteMemberItem["sk"];
        return websiteMemberItem;
    } catch (e) {
        console.error("In addWebsiteMember", e);
        throw "Could not addWebsiteMember";
    }
}

////////////////////////////////////////
// Update Website Member
////////////////////////////////////////
export async function updateWebsiteMember(
    websiteId: any, 
    websiteMemberFirstName: any, 
    websiteMemberLastName: any, 
    websiteMemberUserEmail: any, 
    websiteMemberPhoneNumber: any, 
    websiteMemberSideNote: any,
    ) {
    try {
        const updatedAt = Date.now();
        const command = new UpdateCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_MEMBER + "#" + websiteMemberUserEmail,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #websiteMemberFirstName = :websiteMemberFirstName, #websiteMemberLastName = :websiteMemberLastName, #websiteMembershipLastUpdated = :websiteMembershipLastUpdated, #websiteMemberPhoneNumber = :websiteMemberPhoneNumber, #websiteMemberSideNote = :websiteMemberSideNote",
            ExpressionAttributeNames: {
                '#websiteMemberFirstName': 'websiteMemberFirstName',
                '#websiteMemberLastName': 'websiteMemberLastName',
                '#websiteMembershipLastUpdated': 'websiteMembershipLastUpdated',
                '#websiteMemberPhoneNumber': 'websiteMemberPhoneNumber',
                '#websiteMemberSideNote': 'websiteMemberSideNote',
            },
            ExpressionAttributeValues: {
                ":websiteMemberFirstName": websiteMemberFirstName,
                ":websiteMemberLastName": websiteMemberLastName,
                ":websiteMembershipLastUpdated": updatedAt,
                ":websiteMemberPhoneNumber": websiteMemberPhoneNumber,
                ":websiteMemberSideNote": websiteMemberSideNote,
            },
        });
        await dynamoDbDocumentClient.send(command);
        return updatedAt;
    } catch (e) {
        console.error("In updateWebsiteMember", e);
        throw "Could not updateWebsiteMember";
    }
}

////////////////////////////////////////
// Delete Website Member
////////////////////////////////////////
export async function deleteWebsiteMember(
    websiteId: any, 
    websiteMemberUserEmail: any,
    ) {
    try {
        const command = new DeleteCommand({
            TableName: DEFAULT_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_WEBSITE + "#" + websiteId,
                "sk": appConstants.DYNAMO_ENTITY_MEMBER + "#" + websiteMemberUserEmail,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In deleteWebsiteMember", e);
        throw "Could not deleteWebsiteMember";
    }
}
