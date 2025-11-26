// Imports
import {DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {GetCommand, UpdateCommandOutput} from "@aws-sdk/lib-dynamodb";
import {DB_TABLE_NAME, IN_DEV} from "../../../../../../config";
import {appConstants} from "../../../../../../constants";
import {sessionDBAttributesToSessionData} from "../../../../../core/utils";
import {SessionData} from "../../../../../core/interfaces/view-routes";
import {UserNameAndAvatar} from "../../../../../core/interfaces/user";

/*
* Clients
*/
const { DynamoDBDocumentClient, QueryCommand, PutCommand, UpdateCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");
const dynamoDBClient = new DynamoDBClient({
    region: appConstants.DEFAULT_REGION,
});
const dynamoDbDocumentClient = DynamoDBDocumentClient.from(dynamoDBClient);

/*
* Fetch user ID
*/
export async function fetchUserId(cognitoId: string): Promise<string | null> {
    try {
        const command = new QueryCommand({
            TableName: DB_TABLE_NAME,
            IndexName: "tdo",
            KeyConditionExpression: '#userCognitoId = :userCognitoId',
            ExpressionAttributeNames: {
                "#userCognitoId": "userCognitoId",
            },
            ExpressionAttributeValues: {
                ":userCognitoId": cognitoId,
            },
        });
        let userDocArr = await dynamoDbDocumentClient.send(command);
        if (userDocArr["Items"].length === 0) {
            return null;
        }
        const userDoc = userDocArr["Items"][0];
        if (userDoc["userDeactivated"]) {
            return null;
        }
        return userDoc["pk"].split("#")[1];
    } catch (e) {
        if (IN_DEV) {
            console.warn("In fetchUserId", e);
        }
        return null;
    }
}

/*
* Update user's name & avatar
*/
export async function getUserNameAndAvatar(userId: string): Promise<UserNameAndAvatar | null> {
    try {
        const command: GetCommand = new GetCommand({
            TableName: DB_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
                "sk": appConstants.DYNAMO_ENTITY_PROFILE + "#" + appConstants.DYNAMO_ENTITY_INFO,
            },
        });
        let profileInfoDoc = await dynamoDbDocumentClient.send(command);
        profileInfoDoc = profileInfoDoc.Item;
        if (!profileInfoDoc) {
            return null;
        }
        return {
            userName: profileInfoDoc["userName"],
            userAvatarUri: profileInfoDoc["userAvatarUri"],
        };
    } catch (e) {
        if (IN_DEV) {
            console.error(e);
        }
        return null;
    }
}

/*
* Update user's name
*/
export async function updateUserName(userId: string, userName: string): Promise<boolean> {
    try {
        const command = new UpdateCommand({
            TableName: DB_TABLE_NAME,
            Key: {
                "pk": appConstants.DYNAMO_ENTITY_USER + "#" + userId,
                "sk": appConstants.DYNAMO_ENTITY_PROFILE + "#" + appConstants.DYNAMO_ENTITY_INFO,
            },
            ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
            UpdateExpression: "set #userName = :userName",
            ExpressionAttributeNames: {
                '#userName': 'userName',
            },
            ExpressionAttributeValues: {
                ":userName": userName,
            },
        });
        await dynamoDbDocumentClient.send(command);
        return true;
    } catch (e) {
        if (IN_DEV) {
            console.error(e);
        }
        return false;
    }
}

/*
* Create user session
*/
export async function createUserSession(userId: string, sessionId: string, userName: string, rememberMe: boolean, isUserAdmin: boolean, userAvatarUri: string = ""): Promise<boolean> {
    try {
        const createdAt = Date.now();
        let ttl;
        if (rememberMe) {
            ttl = Math.round((createdAt + appConstants.COOKIE_TIMEOUT_MILLIS_YEAR) / 1000);
        } else {
            ttl = Math.round((createdAt + appConstants.COOKIE_TIMEOUT_MILLIS) / 1000);
        }
        const command = new PutCommand({
            TableName: DB_TABLE_NAME,
            Item: {
                "pk": appConstants.DYNAMO_ENTITY_SESSION + "#" + sessionId,
                "sk": "NA",
                "sessionUserId": userId,
                "sessionUserIsAdmin": isUserAdmin,
                "sessionRememberMe": rememberMe,
                "sessionUserName": userName,
                "sessionUserAvatarUri": userAvatarUri,
                "sessionCreatedAt": createdAt,
                "ttl": ttl,
            },
        });
        await dynamoDbDocumentClient.send(command);
        return true;
    } catch (e) {
        if (IN_DEV) {
            console.error(e);
        }
        return false;
    }
}

/*
* Update user session
*/
export async function updateUserSession(SessionData?: any): Promise<SessionData | null> {
    try {
        if (SessionData) {
            // Extract data
            const sessionId = SessionData["SessionId"];
            const rememberMe = SessionData["RememberMe"];
            if (
                typeof sessionId !== "string" ||
                typeof rememberMe !== "boolean"
            ) {
                return null;
            }

            // Calculate ttl
            const updatedAt = Date.now();
            let ttl;
            if (rememberMe) {
                ttl = Math.round((updatedAt + appConstants.COOKIE_TIMEOUT_MILLIS_YEAR) / 1000);
            } else {
                ttl = Math.round((updatedAt + appConstants.COOKIE_TIMEOUT_MILLIS) / 1000);
            }

            // Execute update
            const command = new UpdateCommand({
                TableName: DB_TABLE_NAME,
                Key: {
                    "pk": appConstants.DYNAMO_ENTITY_SESSION + "#" + sessionId,
                    "sk": "NA",
                },
                ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
                UpdateExpression: "set #ttl = :ttl",
                ExpressionAttributeNames: {
                    '#ttl': 'ttl',
                },
                ExpressionAttributeValues: {
                    ":ttl": ttl,
                },
                ReturnValues: 'ALL_NEW',
            });
            const res: UpdateCommandOutput = await dynamoDbDocumentClient.send(command);
            return sessionDBAttributesToSessionData(res.Attributes);
        } else {
            return null;
        }
    } catch (e) {
        if (IN_DEV) {
            console.error(e);
        }
        return null;
    }
}