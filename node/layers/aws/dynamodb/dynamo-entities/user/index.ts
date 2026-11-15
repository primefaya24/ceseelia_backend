// Imports
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    DynamoDBDocumentClient,
    GetCommand,
    QueryCommand,
    PutCommand,
    UpdateCommand,
    TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import * as ULID from "ulid";
import {appConstants} from "../../../../../constants";
import {DB_TABLE_NAME} from "../../../../../config";
import { log } from "../../../../core/logger";

// Initialize DynamoDB Document Client
const dynamoDbDocumentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({
        region: appConstants.DEFAULT_REGION,
    })
);

// Constants
const DEFAULT_TABLE_NAME: string | undefined = DB_TABLE_NAME;

/* No user rows exist yet for this Cognito identity. Routes map it to 404 PROFILE_NOT_FOUND. */
export class ProfileNotFoundError extends Error {
    constructor() {
        super("Profile not found");
        this.name = "ProfileNotFoundError";
    }
}

/* The user's account is deactivated. Routes map it to 403. */
export class UserDeactivatedError extends Error {
    constructor() {
        super("Account deactivated");
        this.name = "UserDeactivatedError";
    }
}

/*
 * Create the same rows the `OnUserRegister` PostConfirmation Lambda in ../ceseelia_cloudformation
 * writes (keep the two in step). Used by get-my-profile when the Lambda's write failed (it logs
 * and swallows errors), so a confirmed Cognito user is never left without a profile.
 *
 * `attrs` must come from the user pool (getCognitoUserAttributes), never from a request.
 * Returns the user's ID, or null if the email isn't verified (nothing is written then).
 */
export async function createUserRecordsFromCognito(
    attrs: Record<string, string>,
    tableName: string | undefined = DEFAULT_TABLE_NAME,
): Promise<string | null> {
    const cognitoId = attrs["sub"];
    const email = (attrs["email"] ?? "").trim().toLowerCase();
    if (!cognitoId || !email || attrs["email_verified"] !== "true") {
        return null;
    }

    // Names and social provider, parsed like the Lambda does
    const [firstName = "", lastName = ""] = (attrs["custom:userName"] ?? "").split(" ");
    let providerName = "";
    let providerType = "";
    let providerUserId = "";
    if (attrs["identities"]) {
        try {
            const identity = JSON.parse(attrs["identities"])[0] ?? {};
            providerName = identity.providerName ?? "";
            providerType = identity.providerType ?? "";
            providerUserId = identity.userId ?? "";
        } catch {
            // leave empty, as the Lambda would fail to parse too
        }
    }

    const cognitoRow = (userId: string) => ({
        pk: appConstants.DYNAMO_ENTITY_USER + "#" + userId,
        sk: appConstants.DYNAMO_ENTITY_PROFILE + "#" + appConstants.DYNAMO_ENTITY_COGNITO_DATA + "#" + cognitoId,
        userSocialProviderName: providerName,
        userSocialProviderType: providerType,
        userSocialProviderUserId: providerUserId,
        userEmail: email,
        userCognitoId: cognitoId,
        userDeactivated: false,
    });

    // Same verified email already has a user (e.g. another sign-in method): link this identity to it
    const existing: any[] = (await peekUserByEmail(email, tableName)) ?? [];
    if (existing.length > 0) {
        const userId: string = existing[0]["pk"].split("#")[1];
        if (!existing.some((row) => row["sk"].split("#")[2] === cognitoId)) {
            await dynamoDbDocumentClient.send(new PutCommand({ TableName: tableName, Item: cognitoRow(userId) }));
        }
        return userId;
    }

    // New user: all three rows or none
    const userId = ULID.ulid();
    const pk = appConstants.DYNAMO_ENTITY_USER + "#" + userId;
    const put = (Item: Record<string, unknown>) => ({
        Put: { TableName: tableName, Item, ConditionExpression: "attribute_not_exists(pk)" },
    });
    await dynamoDbDocumentClient.send(
        new TransactWriteCommand({
            TransactItems: [
                put({
                    pk,
                    sk: appConstants.DYNAMO_ENTITY_PROFILE + "#" + appConstants.DYNAMO_ENTITY_INFO,
                    userEmailAddress: email,
                    userAvatarUri: "",
                    userFirstName: firstName,
                    userLastName: lastName,
                    userPreferredLocale: appConstants.LOCALE_EN,
                    isProfileComplete: false,
                    userCreatedAt: Date.now(),
                }),
                put(cognitoRow(userId)),
                put({
                    pk,
                    sk: appConstants.DYNAMO_ENTITY_PROFILE + "#" + appConstants.DYNAMO_ENTITY_NOTIFICATION_SETTINGS,
                    userFcmToken: "",
                }),
            ],
        })
    );
    return userId;
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
        const myProfile: any = {};
        for (const profileRecord of userProfileRecords) {
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
        log.error({ err: e }, "In getMyProfile");
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
        log.error({ err: e }, "In updateFcmToken");
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
        const userNotificationSettings: any = await dynamoDbDocumentClient.send(command);
        if (clean) {
            delete userNotificationSettings["Item"]["pk"];
            delete userNotificationSettings["Item"]["sk"];
        }
        return userNotificationSettings["Item"];
    } catch (e) {
        log.error({ err: e }, "In getUserNotificationSettings");
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
        log.error({ err: e }, "In updateFcmToken");
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
        log.error({ err: e }, "In peekUserByEmail");
        throw "Could not find user by email";
    }
}

////////////////////////////////////////
// Fetch user UUID
////////////////////////////////////////
/*
 * The user ID for a Cognito identity, or null if no rows exist yet.
 * Throws UserDeactivatedError for a deactivated account.
 */
export async function findUserIdByCognitoId(
    cognitoId: string,
    tableName: string | undefined = DEFAULT_TABLE_NAME,
): Promise<string | null> {
    const doc = await findCognitoRow(cognitoId, tableName);
    return doc ? doc["pk"].split("#")[1] : null;
}

async function findCognitoRow(cognitoId: string, tableName: string | undefined): Promise<any | null> {
    const res: any = await dynamoDbDocumentClient.send(
        new QueryCommand({
            TableName: tableName,
            IndexName: appConstants.INDEX_NAME_COGNITO_IDENTIFIER_GSI,
            KeyConditionExpression: "#userCognitoId = :userCognitoId",
            ExpressionAttributeNames: { "#userCognitoId": "userCognitoId" },
            ExpressionAttributeValues: { ":userCognitoId": cognitoId },
        })
    );
    const doc = res["Items"]?.[0];
    if (!doc) {
        return null;
    }
    if (doc["userDeactivated"]) {
        throw new UserDeactivatedError();
    }
    return doc;
}

/*
 * The user ID (or, with isStrict=false, the COGNITO_DATA row) for a Cognito identity.
 * Throws ProfileNotFoundError when there are no rows, UserDeactivatedError when deactivated.
 */
export async function fetchUserUUID(
    cognitoId: any,
    isStrict: boolean = true,
    tableName: string | undefined = DEFAULT_TABLE_NAME,
    ) {
    const doc = await findCognitoRow(cognitoId, tableName);
    if (!doc) {
        throw new ProfileNotFoundError();
    }
    return isStrict ? doc["pk"].split("#")[1] : doc;
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
        const userDocArr = await dynamoDbDocumentClient.send(command);
        return userDocArr["Items"];
    } catch (e) {
        log.error({ err: e }, "In fetchUserCognitoItems");
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
        log.error({ err: e }, "In updateUserProfile");
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
        log.error({ err: e }, "In updateUserPlan");
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
        log.error({ err: e }, "In adjustCounter");
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
        log.error({ err: e }, "In adjustCounter");
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
        const userRewardsItem = (await dynamoDbDocumentClient.send(command)).Item;
        if (userRewardsItem) {
            return userRewardsItem["userRewardDollarsEarned"];
        }
        return 0;
    } catch (e) {
        log.error({ err: e }, "In getMyRewards");
        throw "Could not fetch rewards";
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
        log.error({ err: e }, "In getUserRecordKeys");
        throw "Could not getUserRecordKeys";
    }
}

////////////////////////////////////////
// Delete user (L.9)
////////////////////////////////////////
/*
 * Deletes every row under USER#<userId> (profile, sign-in identities, notification settings,
 * push subscriptions, store and ticket pointers). Call last, after the store memberships, the
 * tickets and the Cognito logins are gone. Returns how many rows went.
 */
export async function deleteUserRows(
    userId: string,
    tableName: string | undefined = DEFAULT_TABLE_NAME,
): Promise<number> {
    const { dynamoWriteManyItems } = await import("../../dynamo-batch-ops");
    const keys: Array<{ pk: string; sk: string }> = await getUserRecordKeys(userId, tableName);
    const rows = keys.filter((k) => k && k.pk === appConstants.DYNAMO_ENTITY_USER + "#" + userId);
    if (rows.length) {
        await dynamoWriteManyItems(tableName, rows.map((k) => ({ DeleteRequest: { Key: { pk: k.pk, sk: k.sk } } })));
    }
    return rows.length;
}

/*
 * L.8 / 8.3: who is asking, for a support ticket: the user id, their verified sign-in email (the
 * Cognito row) and their name (the profile). Throws like fetchUserUUID.
 */
export async function getUserContact(cognitoId: string): Promise<{ userId: string; email: string; name: string }> {
    const doc = await fetchUserUUID(cognitoId, false);
    const userId = String(doc["pk"]).split("#")[1];
    const info = (
        await dynamoDbDocumentClient.send(
            new GetCommand({
                TableName: DB_TABLE_NAME,
                Key: { pk: `${appConstants.DYNAMO_ENTITY_USER}#${userId}`, sk: `${appConstants.DYNAMO_ENTITY_PROFILE}#${appConstants.DYNAMO_ENTITY_INFO}` },
                ProjectionExpression: "userFirstName, userLastName",
            })
        )
    ).Item;
    const name = [info?.userFirstName, info?.userLastName].map((s) => String(s ?? "").trim()).filter(Boolean).join(" ");
    return { userId, email: String(doc["userEmail"] ?? ""), name };
}
