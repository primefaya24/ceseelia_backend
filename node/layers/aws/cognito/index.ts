// Imports
import {
    CognitoIdentityProviderClient,
    SignUpCommand,
    SignUpCommandInput,
    SignUpCommandOutput,
    ConfirmSignUpCommand,
    ConfirmSignUpCommandInput,
    ConfirmSignUpCommandOutput,
    AdminInitiateAuthCommand,
    AdminInitiateAuthCommandInput,
    AdminInitiateAuthCommandOutput,
    AuthFlowType,
    ResendConfirmationCodeCommand,
    ResendConfirmationCodeCommandInput,
    ForgotPasswordCommand,
    ForgotPasswordCommandInput, ConfirmForgotPasswordCommand, ConfirmForgotPasswordCommandInput,
    AdminDeleteUserCommand,
    GetUserCommand
} from "@aws-sdk/client-cognito-identity-provider";
import {appConstants} from "../../../constants";
import {
    COGNITO_AUTH_DOMAIN, COGNITO_FEDERATION_REDIRECT_URL,
    COGNITO_USER_POOL_CLIENT_ID,
    COGNITO_USER_POOL_CLIENT_SECRET,
    COGNITO_USER_POOL_ID, IN_DEV
} from "../../../config";
import { createHmac } from 'crypto';
import jwt, { JwtHeader } from "jsonwebtoken";
import jwksClient, { JwksClient } from "jwks-rsa";
import {UserCognitoInfo} from "../../core/interfaces/cognito";
import {decodeJwtToken, encodeBase64, isUserAdmin} from "../../core/utils";

/*
* Clients
*/
const cognitoClient: CognitoIdentityProviderClient = new CognitoIdentityProviderClient({
    region: appConstants.DEFAULT_REGION,
});

const jwksClientInstance: jwksClient.JwksClient = jwksClient({
    jwksUri: `https://cognito-idp.${appConstants.DEFAULT_REGION}.amazonaws.com/${getCognitoPoolId()}/.well-known/jwks.json`,
    cache: true,
    cacheMaxEntries: 5,
    cacheMaxAge: 10 * 60 * 1000 // 10 minutes
});

const jwksClientInstanceWoo: jwksClient.JwksClient = jwksClient({
    jwksUri: `https://cognito-idp.${appConstants.DEFAULT_REGION}.amazonaws.com/${getCognitoPoolIdWoo()}/.well-known/jwks.json`,
    cache: true,
    cacheMaxEntries: 5,
    cacheMaxAge: 10 * 60 * 1000 // 10 minutes
});

/*
* Helpers
*/
function calcCognitoSecretHash(username: string): string {
    const hmac = createHmac('sha256', COGNITO_USER_POOL_CLIENT_SECRET);
    hmac.update(`${username}${COGNITO_USER_POOL_CLIENT_ID}`);
    return hmac.digest('base64');
}

/*
* User Signup
*/
export async function signup(email: string, password: string): Promise<SignUpCommandOutput> {
    const signUpCommandInput: SignUpCommandInput = {
        ClientId: COGNITO_USER_POOL_CLIENT_ID,
        Username: email,
        Password: password,
        SecretHash: calcCognitoSecretHash(email),
    };
    const command = new SignUpCommand(signUpCommandInput);
    return await cognitoClient.send(command);
}

/*
* User Signup
*/
export async function confirmSignup(email: string, code: string): Promise<ConfirmSignUpCommandOutput> {
    const confirmSignUpCommandInput: ConfirmSignUpCommandInput = {
        ClientId: COGNITO_USER_POOL_CLIENT_ID,
        Username: email,
        ConfirmationCode: code,
        SecretHash: calcCognitoSecretHash(email),
    };
    const command = new ConfirmSignUpCommand(confirmSignUpCommandInput);
    return await cognitoClient.send(command);
}

/*
* User SignIn
*/
export async function signIn(email: string, password: string): Promise<UserCognitoInfo> {
    const adminInitiateAuthCommandInput: AdminInitiateAuthCommandInput = {
        ClientId: COGNITO_USER_POOL_CLIENT_ID,
        UserPoolId: COGNITO_USER_POOL_ID,
        AuthFlow: AuthFlowType.ADMIN_USER_PASSWORD_AUTH,
        AuthParameters: {
            USERNAME: email,
            PASSWORD: password,
            SECRET_HASH: calcCognitoSecretHash(email),
        },
    };
    const command = new AdminInitiateAuthCommand(adminInitiateAuthCommandInput);
    const adminInitiateAuthCommandOutput: AdminInitiateAuthCommandOutput = await cognitoClient.send(command);
    const accessToken = adminInitiateAuthCommandOutput.AuthenticationResult?.AccessToken!;
    const decodedToken = decodeJwtToken(accessToken);
    const cognitoId = decodedToken["sub"];
    return {
        cognitoId: cognitoId,
        isAdmin: isUserAdmin(decodedToken),
    }
}

/*
* Resend confirmation code
*/
export async function resendConfirmationCode(email: string): Promise<AdminInitiateAuthCommandOutput> {
    const resendConfirmationCodeCommandInput: ResendConfirmationCodeCommandInput = {
        ClientId: COGNITO_USER_POOL_CLIENT_ID,
        SecretHash: calcCognitoSecretHash(email),
        Username: email,
    };
    const command = new ResendConfirmationCodeCommand(resendConfirmationCodeCommandInput);
    return await cognitoClient.send(command);
}

/*
* Initialize forgot password flow
*/
export async function initForgotPasswordFlow(email: string): Promise<AdminInitiateAuthCommandOutput> {
    const forgotPasswordCommandInput: ForgotPasswordCommandInput = {
        ClientId: COGNITO_USER_POOL_CLIENT_ID,
        SecretHash: calcCognitoSecretHash(email),
        Username: email,
    };
    const command = new ForgotPasswordCommand(forgotPasswordCommandInput);
    return await cognitoClient.send(command);
}

/*
* Initialize forgot password flow
*/
export async function finalizeForgotPasswordFlow(email: string, password: string, confirmationCode: string): Promise<AdminInitiateAuthCommandOutput> {
    const confirmForgotPasswordCommandInput: ConfirmForgotPasswordCommandInput = {
        ClientId: COGNITO_USER_POOL_CLIENT_ID,
        SecretHash: calcCognitoSecretHash(email),
        Username: email,
        Password: password,
        ConfirmationCode: confirmationCode,
    };
    const command = new ConfirmForgotPasswordCommand(confirmForgotPasswordCommandInput);
    return await cognitoClient.send(command);
}

/*
* Process auth code
*/
export async function processAuthCode(code: string): Promise<UserCognitoInfo | null> {
    const reqBody = {
        grant_type: appConstants.COGNITO_GRANT_TYPE_CODE,
        client_id: COGNITO_USER_POOL_CLIENT_ID,
        code: code,
        redirect_uri: COGNITO_FEDERATION_REDIRECT_URL,
    };
    const params: string = `grant_type=${reqBody.grant_type}&client_id=${reqBody.client_id}&code=${reqBody.code}&redirect_uri=${reqBody.redirect_uri}`;
    const base64Auth = encodeBase64(`${COGNITO_USER_POOL_CLIENT_ID}:${COGNITO_USER_POOL_CLIENT_SECRET}`);
    const res = await fetch(COGNITO_AUTH_DOMAIN + `?${params}`, {
        method: "POST",
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            "Authorization": `Basic ${base64Auth}`
        },
    });
    if (res.ok) {
        const resBody = await res.json();
        const accessToken: string = resBody["access_token"];
        const decodedToken = decodeJwtToken(accessToken);
        const cognitoId = decodedToken["sub"];
        return {
            cognitoId: cognitoId,
            isAdmin: isUserAdmin(decodedToken),
        }
    } else {
        if (IN_DEV) {
            const errBody = await res.json();
            console.error(errBody);
        }
        return null;
    }
}

/**
 * Get Cognito pool ID based on environment
 */
export function getCognitoPoolId(): string {
    return IN_DEV
        ? "us-east-1_fY0cbRBIl"
        : "us-east-1_TuqME5zjJ";
}

/**
 * Get Cognito pool Client ID based on environment
 */
export function getCognitoPoolClientId(): string {
    return IN_DEV
        ? "1qltt5stlpd1v26pi70cb2el0d"
        : "5o5od38tol2jc7pg6l8vptp4tp";
}

/**
 * Get WOO Cognito pool ID based on environment
 */
export function getCognitoPoolIdWoo(): string {
    return IN_DEV
        ? "us-east-1_BalfHiOud"
        : "us-east-1_hJcgbGvzZ";
}

/**
 * Get WOO Cognito pool Client ID based on environment
 */
export function getCognitoPoolClientIdWoo(): string {
    return IN_DEV
        ? "6luq2dc04v8j3983rupqhsh3bl"
        : "4plut45qrvc22p5n0fb70cvgvv";
}

/**
 * Extract Cognito usernames from social login/user data
 */
function extractCognitoUsernamesFromCognitoData(
    userCognitoData: {
        userCognitoId: string;
        userSocialProviderType: string;
        userSocialProviderName: string;
        userSocialProviderUserId: string;
    }[]
): string[] {
    const cognitoUsernames: string[] = [];

    for (const user of userCognitoData) {
        if (user.userSocialProviderType.length === 0) {
            cognitoUsernames.push(user.userCognitoId);
        } else {
            cognitoUsernames.push(`${user.userSocialProviderName}_${user.userSocialProviderUserId}`);
        }
    }

    return cognitoUsernames;
}

/**
 * Delete user(s) from Cognito
 */
export async function deleteUser(
    userCognitoData: any[]
): Promise<void> {
    try {
        const cognitoUsernames = extractCognitoUsernamesFromCognitoData(userCognitoData);

        for (const username of cognitoUsernames) {
            const command = new AdminDeleteUserCommand({
                UserPoolId: getCognitoPoolId(),
                Username: username
            });
            await cognitoClient.send(command);
        }
    } catch (e) {
        console.error("In adminDeleteUser", e);
        throw new Error("Could not delete user in Cognito");
    }
}

/**
 * Retrieve public signing key for JWT verification
 */
async function getSigningKey(kid: string, jwksClientInstance: jwksClient.JwksClient): Promise<string> {
    try {
        return new Promise((resolve, reject) => {
            jwksClientInstance.getSigningKey(kid, (err, key) => {
                if (err) {
                    reject(err);
                } else {
                    const pubKey = key?.getPublicKey();
                    if (pubKey) resolve(pubKey);
                    else reject(new Error("Could not get public key"));
                }
            });
        });
    } catch (err) {
        console.error("Error fetching signing key:", err);
        throw new Error("Invalid token: Unable to retrieve signing key");
    }
}

/**
 * Check if token is still active (not revoked)
 */
async function isTokenActive(accessToken: string): Promise<boolean> {
    try {
        const command: GetUserCommand = new GetUserCommand({ AccessToken: accessToken });
        await cognitoClient.send(command);
        return true;
    } catch (error: any) {
        console.error("Error in isTokenActive:", error.message);
        return false;
    }
}

/**
 * Verify and validate Cognito access token
 */
export async function verifyCognitoAccessToken(
    token: string,
    userPoolId: string = getCognitoPoolId(),
): Promise<jwt.JwtPayload> {
    const decoded = jwt.decode(token, { complete: true }) as {
        header: JwtHeader;
        payload: jwt.JwtPayload;
    } | null;

    if (!decoded) {
        throw new Error("Invalid JWT Token");
    }

    if (decoded.payload.token_use !== "access") {
        throw new Error("Not an access token");
    }

    const expectedIssuer = `https://cognito-idp.${appConstants.DEFAULT_REGION}.amazonaws.com/${userPoolId}`;
    if (decoded.payload.iss !== expectedIssuer) {
        throw new Error("Invalid token issuer");
    }

    if (IN_DEV) {
        return decoded;
    }

    const publicKey: string = await getSigningKey(decoded.header.kid!, userPoolId === getCognitoPoolId() ? jwksClientInstance : jwksClientInstanceWoo);

    const verifiedToken = jwt.verify(token, publicKey, {
        algorithms: ["RS256"]
    }) as jwt.JwtPayload;

    if (verifiedToken.exp && verifiedToken.exp < Math.floor(Date.now() / 1000)) {
        throw new Error("Token has expired");
    }

    // const active = await isTokenActive(accessToken);
    // if (!active) {
    //     throw new Error("Token has been revoked");
    // }

    return verifiedToken;
}

export async function isCognitoTokenValid(
    token: string,
    userPoolId: string = getCognitoPoolId()
): Promise<boolean> {
    try {
        if (!token) {
            return false;
        }
        if (token.length === 0) {
            return false;
        }
        const verified: jwt.JwtPayload = await verifyCognitoAccessToken(token, userPoolId);
        return !!verified;
    } catch (err) {
        console.error("Invalid token:", err);
        return false;
    }
}