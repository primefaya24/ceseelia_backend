// Imports
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    DynamoDBDocumentClient,
    GetCommand,
    QueryCommand,
    PutCommand,
    UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import * as ULID from "ulid";
import {appConstants} from "../../../../../constants";
import {dynamoWriteManyItems} from "../../dynamo-batch-ops";
import {DB_TABLE_NAME} from "../../../../../config";
import {getAllWebsiteDataKeys, getWebsiteMemberships} from "../website";

// Initialize DynamoDB Document Client
const dynamoDbDocumentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({
        region: appConstants.DEFAULT_REGION,
    })
);

// Constants
const DEFAULT_TABLE_NAME: string | undefined = DB_TABLE_NAME;

////////////////////////////////////////
// Register a new user.
////////////////////////////////////////
export async function registerUser(
    firstName: any, 
    lastName: any, 
    email: any, 
    cognitoId: any,
    userSocialProviderName: any,
    userSocialProviderType: any, 
    userSocialProviderUserId: any, 
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        // Peek user via email
        let userCognitoData = await peekUserByEmail(email, tableName);
        if (userCognitoData && userCognitoData.length > 0) {
            let duplicateRegistration = false;
            for (let userCognito of userCognitoData) {
                if (userCognito["sk"].split("#")[2].valueOf() == cognitoId.valueOf()) {
                    duplicateRegistration = true;
                    break;
                }
            }

            // User registered via federation or other cognito source with same email
            if (!duplicateRegistration) {
                // Record cognito id in the user's profile
                const command = new PutCommand({
                    TableName: tableName,
                    Item: {
                        "pk": appConstants.DYNAMO_ENTITY_USER + "#" + userCognitoData[0]["pk"].split("#")[1],
                        "sk": appConstants.DYNAMO_ENTITY_PROFILE + "#" + appConstants.DYNAMO_ENTITY_COGNITO_DATA
                            + "#" + cognitoId,
                        "userSocialProviderName": userSocialProviderName,
                        "userSocialProviderType": userSocialProviderType,
                        "userSocialProviderUserId": userSocialProviderUserId,
                        "userEmail": email,
                        "userCognitoId": cognitoId,
                        "userDeactivated": false,
                    }
                });
                await dynamoDbDocumentClient.send(command);
            }
            else {
                throw "User already registered";
            }
        }

        else {
            // New user
            const userUUID = ULID.ulid();
            const createdAt = Date.now();

            // Write batch
            await dynamoWriteManyItems(tableName, [
                // User info
                {
                    PutRequest: {
                        Item: {
                            "pk": appConstants.DYNAMO_ENTITY_USER + "#" + userUUID,
                            "sk": appConstants.DYNAMO_ENTITY_PROFILE + "#" + appConstants.DYNAMO_ENTITY_INFO,
                            "userPlan": appConstants.PLAN_TYPE_FREE,
                            "userEmailAddress": email,
                            "userAvatarUri": "",
                            "userFirstName": firstName,
                            "userLastName": lastName,
                            "userPreferredLocale": appConstants.LOCALE_EN,
                            "isProfileComplete": false,
                            "userCreatedAt": createdAt,
                        }
                    }
                },
                // User cognito ids
                {
                    PutRequest: {
                        Item: {
                            "pk": appConstants.DYNAMO_ENTITY_USER + "#" + userUUID,
                            "sk": appConstants.DYNAMO_ENTITY_PROFILE + "#" + appConstants.DYNAMO_ENTITY_COGNITO_DATA + "#" + cognitoId,
                            "userSocialProviderName": userSocialProviderName,
                            "userSocialProviderType": userSocialProviderType,
                            "userSocialProviderUserId": userSocialProviderUserId,
                            "userEmail": email,
                            "userCognitoId": cognitoId,
                            "userDeactivated": false,
                        }
                    }
                },
                // User notification settings
                {
                    PutRequest: {
                        Item: {
                            "pk": appConstants.DYNAMO_ENTITY_USER + "#" + userUUID,
                            "sk": appConstants.DYNAMO_ENTITY_PROFILE + "#" + appConstants.DYNAMO_ENTITY_NOTIFICATION_SETTINGS,
                            "userFcmToken": "",
                        }
                    }
                },
            ]);
        }
    } catch (e) {
        console.error("In registerUser", e);
        throw e;
    }
}

////////////////////////////////////////
// Get profile
////////////////////////////////////////
export async function getMyProfile(
    userUUID: any, 
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        // Get user profile records
        const command = new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: '#pk = :pk and begins_with(#sk, :sk_prefix)',
            ExpressionAttributeNames: {
                "#pk": "pk",
                "#sk": "sk",
            },
            ExpressionAttributeValues: {
                ":pk": appConstants.DYNAMO_ENTITY_USER + "#" + userUUID,
                ":sk_prefix": appConstants.DYNAMO_ENTITY_PROFILE + "#",
            },
        });
        let userProfileRecords: any = await dynamoDbDocumentClient.send(command);
        userProfileRecords = userProfileRecords["Items"];

        // Construct user profile with desired data
        let myProfile: any = {};
        for (let profileRecord of userProfileRecords) {
            // Info & plan
            if (profileRecord["sk"].includes(appConstants.DYNAMO_ENTITY_INFO)) {
                myProfile["info"] = profileRecord;
                myProfile["info"]["userId"] = userUUID;
                delete myProfile["info"]["pk"];
                delete myProfile["info"]["sk"];
            }
        }
        return myProfile;
    } catch (e) {
        console.error("In getMyProfile", e);
        throw "Could not fetch profile";
    }
}

////////////////////////////////////////
// Update fcm token
////////////////////////////////////////
export async function updateFcmToken(
    userId: any, 
    fcmToken: any, 
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        const command = new UpdateCommand({
            TableName: tableName,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
                "sk": appConstants.DYNAMO_ENTITY_PROFILE + "#" + appConstants.DYNAMO_ENTITY_NOTIFICATION_SETTINGS,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #userFcmToken = :userFcmToken",
            ExpressionAttributeNames: {
                '#userFcmToken': 'userFcmToken'
            },
            ExpressionAttributeValues: {
                ":userFcmToken": fcmToken,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In updateFcmToken", e);
        throw "Could not update user fcm token";
    }
}

////////////////////////////////////////
// Get user notification settings
////////////////////////////////////////
export async function getUserNotificationSettings(
    userId: any,
    clean: boolean = true,
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        const command = new GetCommand({
            TableName: tableName,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
                "sk": appConstants.DYNAMO_ENTITY_PROFILE + "#" + appConstants.DYNAMO_ENTITY_NOTIFICATION_SETTINGS,
            },
        });
        let userNotificationSettings: any = await dynamoDbDocumentClient.send(command);
        if (clean) {
            delete userNotificationSettings["Item"]["pk"];
            delete userNotificationSettings["Item"]["sk"];
        }
        return userNotificationSettings["Item"];
    } catch (e) {
        console.error("In getUserNotificationSettings", e);
        throw "Could not fetch user notification settings";
    }
}

////////////////////////////////////////
// Update user locale
////////////////////////////////////////
export async function updateUserLocale(
    userId: any, 
    locale: any, 
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        const command = new UpdateCommand({
            TableName: tableName,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
                "sk": appConstants.DYNAMO_ENTITY_PROFILE + "#" + appConstants.DYNAMO_ENTITY_INFO,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #userPreferredLocale = :userPreferredLocale",
            ExpressionAttributeNames: {
                '#userPreferredLocale': 'userPreferredLocale'
            },
            ExpressionAttributeValues: {
                ":userPreferredLocale": locale,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In updateFcmToken", e);
        throw "Could not update user fcm token";
    }
}

////////////////////////////////////////
// Fetch user email
////////////////////////////////////////
export async function peekUserByEmail(
    email: any, 
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        const command = new QueryCommand({
            TableName: tableName,
            IndexName: appConstants.INDEX_NAME_USER_EMAIL_GSI,
            KeyConditionExpression: '#userEmail = :userEmail',
            ExpressionAttributeNames: {
                "#userEmail": "userEmail",
            },
            ExpressionAttributeValues: {
                ":userEmail": email,
            }
        });
        const userDocArr = await dynamoDbDocumentClient.send(command);
        return userDocArr["Items"];
    } catch (e) {
        console.error("In peekUserByEmail", e);
        throw "Could not find user by email";
    }
}

////////////////////////////////////////
// Fetch user UUID
////////////////////////////////////////
export async function fetchUserUUID(
    cognitoId: any, 
    isStrict: boolean = true, 
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        const command = new QueryCommand({
            TableName: tableName,
            IndexName: appConstants.INDEX_NAME_COGNITO_IDENTIFIER_GSI,
            KeyConditionExpression: '#userCognitoId = :userCognitoId',
            ExpressionAttributeNames: {
                "#userCognitoId": "userCognitoId",
            },
            ExpressionAttributeValues: {
                ":userCognitoId": cognitoId,
            },
        });
        let userDocArr: any = await dynamoDbDocumentClient.send(command);
        const userDoc = userDocArr["Items"][0];
        if (userDoc["userDeactivated"]) {
            throw appConstants.USER_DEACTIVATED_ERROR;
        }
        return isStrict ? userDoc["pk"].split("#")[1] : userDoc;
    } catch (e) {
        console.error("In fetchUserUUID", e);
        throw "Invalid Token";
    }
}

////////////////////////////////////////
// Fetch user cognitoId
////////////////////////////////////////
export async function fetchUserCognitoItems(
    userId: any, 
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ): Promise<any> {
    try {
        const command = new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: '#pk = :pk and begins_with(#sk, :sk_prefix)',
            ExpressionAttributeNames: {
                "#pk": "pk",
                "#sk": "sk",
            },
            ExpressionAttributeValues: {
                ":pk": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
                ":sk_prefix": appConstants.DYNAMO_ENTITY_PROFILE + "#" + appConstants.DYNAMO_ENTITY_COGNITO_DATA + "#",
            },
        });
        let userDocArr = await dynamoDbDocumentClient.send(command);
        return userDocArr["Items"];
    } catch (e) {
        console.error("In fetchUserCognitoItems", e);
        throw "Could not fetch iser cognito data";
    }
}

////////////////////////////////////////
// Update user profile
////////////////////////////////////////
export async function updateUserProfile(
    userId: any, 
    userFirstName: any, 
    userLastName: any, 
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        const command = new UpdateCommand({
            TableName: tableName,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
                "sk": appConstants.DYNAMO_ENTITY_PROFILE + "#" + appConstants.DYNAMO_ENTITY_INFO,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #userFirstName = :userFirstName, #userLastName = :userLastName, #isProfileComplete = :isProfileComplete",
            ExpressionAttributeNames: {
                '#userFirstName': 'userFirstName',
                '#userLastName': 'userLastName',
                '#isProfileComplete': 'isProfileComplete',
            },
            ExpressionAttributeValues: {
                ":userFirstName": userFirstName,
                ":userLastName": userLastName,
                ":isProfileComplete": true,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In updateUserProfile", e);
        throw "Could not update user profile";
    }
}

////////////////////////////////////////
// Update user plan
////////////////////////////////////////
export async function updateUserPlan(
    userId: any, 
    userPlan: any, 
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        const command = new UpdateCommand({
            TableName: tableName,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
                "sk": appConstants.DYNAMO_ENTITY_PROFILE + "#" + appConstants.DYNAMO_ENTITY_INFO,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #userPlan = :userPlan",
            ExpressionAttributeNames: {
                '#userPlan': 'userPlan',
            },
            ExpressionAttributeValues: {
                ":userPlan": userPlan,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In updateUserPlan", e);
        throw "Could not update user plan";
    }
}

////////////////////////////////////////
// Adjust user counter
////////////////////////////////////////
export async function adjustCounter(
    userId: any, 
    counterName: any, 
    adjustmentValue: any, 
    increase: boolean = true, 
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        const command = new UpdateCommand({
            TableName: tableName,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
                "sk": appConstants.DYNAMO_ENTITY_PROFILE + "#" + appConstants.DYNAMO_ENTITY_COUNTS,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "ADD " + counterName + " :inc",
            ExpressionAttributeValues: {
                ":inc": increase ? adjustmentValue : -1 * adjustmentValue,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In adjustCounter", e);
        throw "Could not adjust project counters";
    }
}

////////////////////////////////////////
// Adjust user counter
////////////////////////////////////////
export async function adjustUserRewardDollarsEarned(
    userId: any, 
    websiteId: any, 
    adjustmentValue: any, 
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        const command = new UpdateCommand({
            TableName: tableName,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
                "sk": appConstants.DYNAMO_ENTITY_REWARDS + "#" + websiteId,
            },
            UpdateExpression: "ADD userRewardDollarsEarned :inc",
            ExpressionAttributeValues: {
                ":inc": adjustmentValue,
            },
        });
        await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.error("In adjustCounter", e);
        throw "Could not adjust project counters";
    }
}

////////////////////////////////////////
// Get user rewards for a given website
////////////////////////////////////////
export async function getMyRewards(
    userId: any, 
    websiteId: any, 
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        const command = new GetCommand({
            TableName: tableName,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
                "sk": appConstants.DYNAMO_ENTITY_REWARDS + "#" + websiteId,
            },
        });
        let userRewardsItem = (await dynamoDbDocumentClient.send(command)).Item;
        if (userRewardsItem) {
            return userRewardsItem["userRewardDollarsEarned"];
        }
        return 0;
    } catch (e) {
        console.error("In getMyRewards", e);
        throw "Could not fetch rewards";
    }
}

////////////////////////////////////////
// Helper: Fetch user operational data (ancestorItem GSI)
////////////////////////////////////////
export async function fetchUserOperationDataPrimaryKeys(
    userId: any, 
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        let result: any[] = [];
        let query: any, command: any, dataItemKeys: any, exclusiveStartKey: any;
        do {
            query = {
                TableName: tableName,
                IndexName: appConstants.INDEX_NAME_ITEM_ANCESTRY_GSI,
                KeyConditionExpression: '#itemAncestor = :itemAncestor',
                ProjectionExpression: '#pk, #itemAncestor, #sk',
                ExpressionAttributeNames: {
                    "#pk": "pk",
                    "#itemAncestor": "itemAncestor",
                    "#sk": "sk",
                },
                ExpressionAttributeValues: {
                    ":itemAncestor": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
                },
            };
            if (exclusiveStartKey) {
                query["ExclusiveStartKey"] = exclusiveStartKey;
            }
            command = new QueryCommand(query);
            dataItemKeys = await dynamoDbDocumentClient.send(command);
            result = [...result, ...dataItemKeys["Items"]];
            exclusiveStartKey = dataItemKeys["LastEvaluatedKey"];
        } while (exclusiveStartKey);
        return result;
    } catch (e) {
        console.error("In fetchUserOperationDataPrimaryKeys", e);
        throw "Could not fetch user operation data primary keys";
    }
}

////////////////////////////////////////
// Get user record keys
////////////////////////////////////////
export async function getUserRecordKeys(
    userId: any,
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        let userRecordKeys: any[] = [];
        let lastEvaluatedKey;

        do {
            const command: QueryCommand = new QueryCommand({
                TableName: tableName,
                KeyConditionExpression: '#pk = :pk',
                ProjectionExpression: "#pk, #sk",
                ExpressionAttributeNames: {
                    "#pk": "pk",
                    "#sk": "sk",
                },
                ExpressionAttributeValues: {
                    ":pk": appConstants.DYNAMO_ENTITY_USER + "#" + userId
                },
                ExclusiveStartKey: lastEvaluatedKey // for pagination
            });

            const result = await dynamoDbDocumentClient.send(command);
            userRecordKeys = userRecordKeys.concat(result.Items);

            // Update the lastEvaluatedKey to paginate if more data is available
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey); // Continue fetching data until there's no more

        return userRecordKeys;
    } catch (e) {
        console.error("In getUserRecordKeys", e);
        throw "Could not getUserRecordKeys";
    }
}

////////////////////////////////////////
// Delete user
////////////////////////////////////////
export async function deleteUserDB(
    userId: any, 
    userEmail: any, 
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    try {
        // Construct batch of delete requests
        const deleteRequests = [];

        // Get websites items created by user
        const websites = await getWebsiteMemberships(userEmail);
        const websiteIds = [];
        for (let website of websites) {
            if (website["websiteMemberPermission"] === appConstants.USER_PERMISSION_ADMIN && website["websiteMemberStatus"] === appConstants.DYNAMO_ENTITY_APPROVED) {
                websiteIds.push(website["websiteId"]);
                deleteRequests.push({
                    DeleteRequest: {
                        Key: {
                            "pk": appConstants.DYNAMO_ENTITY_APP + "#" + appConstants.DYNAMO_ENTITY_WEBSITE,
                            "sk": appConstants.DYNAMO_ENTITY_INFO + "#" + website["websiteId"],
                        },
                    }
                });
            }
        }

        // Query data for all user websites
        const allWebsiteDataPromises = websiteIds.map(websiteId => getAllWebsiteDataKeys(websiteId));
        const allWebsiteDataResults = await Promise.all(allWebsiteDataPromises);
        const flattenedResults = allWebsiteDataResults.flat();
        for (let websiteItemKey of flattenedResults) {
            deleteRequests.push({
                DeleteRequest: {
                    Key: websiteItemKey,
                }
            });
        }

        // Get user records
        const userRecordKeys = await getUserRecordKeys(userId);
        for (let userRecordKey of userRecordKeys) {
            deleteRequests.push({
                DeleteRequest: {
                    Key: userRecordKey,
                }
            });
        }

        // Perform delete
        await dynamoWriteManyItems(tableName, deleteRequests);

        return websiteIds;
    } catch (e) {
        console.error("In deleteUser", e);
        throw "Could not delete user";
    }
}