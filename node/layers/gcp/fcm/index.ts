// Imports
import { google } from "googleapis";
import {getObjectBuffer} from "../../aws/s3";
import {appConstants} from "../../../constants";
import {sendHttpsRequest} from "../../core/utils";
import {getUserNotificationSettings, peekUserByEmail} from "../../aws/dynamodb/dynamo-entities/user";

/**
 * Fetches the FCM token for a user by user ID.
 */
export async function fetchUserFcmToken(userId: string): Promise<string | null> {
    try {
        const userNotificationSettings = await getUserNotificationSettings(userId);
        return userNotificationSettings["userFcmToken"] ?? null;
    } catch (e) {
        console.error("In fetchUserFcmToken", e);
        return null;
    }
}

/**
 * Fetches the FCM token for a user by email.
 */
export async function fetchUserFcmTokenByEmail(userEmail: string): Promise<string | null> {
    try {
        const userCognitoData: any = await peekUserByEmail(userEmail);
        if (userCognitoData && userCognitoData.length > 0) {
            const userId: string = userCognitoData[0]["pk"].split("#")[1];
            return await fetchUserFcmToken(userId);
        }
        return null;
    } catch (e) {
        console.error("In fetchUserFcmTokenByEmail", e);
        return null;
    }
}

/**
 * Sends a push notification to the given FCM token.
 */
export async function sendPushNotification(
    userFcmToken: string,
    title: string,
    body: string,
    data: Record<string, string>
): Promise<void> {
    try {
        if (userFcmToken?.length > 0) {
            const gcpSecretBuffer: Buffer = await getObjectBuffer(
                appConstants.S3_BUCKET_PRIMEFAYA_PRIVATE_STORAGE,
                appConstants.S3_BUCKET_PRIMEFAYA_GCP_FCM_PKEY
            );

            const serviceAccount = JSON.parse(gcpSecretBuffer.toString());

            const scopes: string[] = [
                "https://www.googleapis.com/auth/firebase.messaging",
            ];

            const jwtClient = new google.auth.JWT(
                serviceAccount.client_email,
                undefined,
                serviceAccount.private_key.replace(/\\n/gm, "\n"),
                scopes
            );

            const res = await jwtClient.authorize();

            if (!res.access_token) {
                throw new Error("Provided service account does not have permission to generate access tokens");
            }

            // Include title and body in data
            data["title"] = title;
            data["body"] = body;

            const reqBody = JSON.stringify({
                message: {
                    token: userFcmToken,
                    notification: {
                        title,
                        body,
                    },
                    data,
                    android: {
                        priority: "high",
                        notification: {
                            sound: "default"
                        }
                    },
                    apns: {
                        headers: {
                            "apns-priority": "10",
                        },
                        payload: {
                            aps: {
                                sound: "default"
                            },
                        }
                    }
                }
            });

            const reqOptions = {
                host: 'fcm.googleapis.com',
                path: `/v1/projects/${appConstants.FIREBASE_PROJECT_NAME}/messages:send`,
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + res.access_token,
                    'Content-Type': 'application/json'
                }
            };

            await sendHttpsRequest(reqOptions, reqBody);
        }
    } catch (e) {
        console.error("In sendPushNotification", e);
    }
}
