/*
* Finalize registration and create session
*/
import {UserNameAndAvatar} from "../../interfaces/user";
import {
    createUserSession,
    fetchUserId,
    getUserNameAndAvatar,
    updateUserName
} from "../../../aws/dynamodb/dynamo-entities/user/woo";
const ULID = require('ulid');

/*
* Update user's name in DB and create session
* Return sessionId
*/
export async function finalizeRegistrationAndCreateSession(cognitoId: string, userName: string, rememberMe: boolean): Promise<string | null> {
    // Fetch userId using accessToken from DB
    const userId = await fetchUserId(cognitoId);
    if (!userId) {
        return null;
    }

    // Populate user's name in DB
    const nameUpdated = await updateUserName(userId, userName);
    if (!nameUpdated) {
        return null;
    }

    // Create session in DB
    const sessionId = ULID.ulid();
    const sessionCreated = await createUserSession(userId, sessionId, userName, rememberMe, false);
    if (!sessionCreated) {
        return null;
    }

    // Return sessionId
    return sessionId;
}

/*
* Fetch user's name and create session
* Return sessionId
*/
export async function loginAndCreateSession(cognitoId: string, rememberMe: boolean, isAdmin: boolean): Promise<string | null> {
    // Fetch userId using accessToken from DB
    const userId = await fetchUserId(cognitoId);
    if (!userId) {
        return null;
    }

    // Fetch user's name
    const userNameAndAvatar: UserNameAndAvatar | null = await getUserNameAndAvatar(userId);
    if (!userNameAndAvatar) {
        return null;
    }

    // Create session in DB
    const sessionId = ULID.ulid();
    const sessionCreated = await createUserSession(userId, sessionId, userNameAndAvatar.userName, rememberMe, isAdmin, userNameAndAvatar.userAvatarUri);
    if (!sessionCreated) {
        return null;
    }

    // Return sessionId
    return sessionId;
}