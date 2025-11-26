import {fetchUserFcmTokenByEmail, sendPushNotification} from "../../../../gcp/fcm";
import {getWebsiteMembershipsRecords} from "../../../../aws/dynamodb/dynamo-entities/website";
import {appConstants} from "../../../../../constants";

export async function wooNotifyTeamMembers(websiteId: string, notificationType: any, title: string, body: any): Promise<void> {
    try {
        const websiteMembers: any = await getWebsiteMembershipsRecords(websiteId);
        await Promise.all(
            websiteMembers
                .filter((member: any) => member["websiteMemberUserEmail"] !== appConstants.ADMIN_CONTACT_EMAIL_ADDRESS) // Exclude this email
                .map(async (member: any) => {
                    const websiteUserFcmToken: any = await fetchUserFcmTokenByEmail(member["websiteMemberUserEmail"]);
                    const data = {
                        event: notificationType,
                        websiteId: websiteId,
                    };
                    return sendPushNotification(websiteUserFcmToken, title, body, data);
                })
        );
    }
    catch (err) {
        console.error("In dqs: wooNotifyTeamMembers", err);
    }
}