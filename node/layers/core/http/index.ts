import {appConstants} from "../../../constants";
import {Request, Response} from 'express';
import jwt from "jsonwebtoken";
import {isUserAdmin} from "../utils";
import {verifyCognitoAccessToken} from "../../aws/cognito";
import { COGNITO_USER_POOL_ID, IN_DEV } from "../../../config";

/*
* Interim lockdown (progress.md S.0): there is no user↔store membership yet, so any signed-in
* user could act on any store. Until the store-access check lands (Stage 1.3), every
* authenticated /store/** route passes this as `adminOnly`. Remove it once 1.3 is in place.
*/
export const STORE_ROUTES_ADMIN_ONLY = true;

type RouteCheck = (req: Request) => boolean;
type RouteCore = (req: Request, res: Response) => Promise<void> | void;

/*
* Extract the raw access token from the Authorization header ("<token>" or "Bearer <token>")
*/
export function extractAccessToken(req: Request): string | null {
    const header = req.headers.authorization;
    if (typeof header !== "string") {
        return null;
    }
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
    return token.length > 0 ? token : null;
}

/*
* Verified identity of the signed-in user. It lives in `res.locals.auth`, which only the server
* writes, never in the client-controlled body. The raw token isn't kept (it could end up in logs).
*/
export interface AuthContext {
    cognitoId: string;
    groups: string[];
    isAdmin: boolean;
}

/* Keys the old wrapper put on req.body. Removed from every request so no code can trust them. */
const LEGACY_IDENTITY_KEYS = ["cognito_token", "cognito_id", "cognito_groups", "is_user_admin"];

function attachIdentity(res: Response, claims: jwt.JwtPayload): void {
    const groups: string[] = Array.isArray(claims["cognito:groups"]) ? claims["cognito:groups"] : [];
    const auth: AuthContext = {
        cognitoId: String(claims.sub ?? ""),
        groups,
        isAdmin: isUserAdmin(groups),
    };
    res.locals.auth = auth;
}

/*
* The signed-in user's identity. Only call from routes registered with withAuth=true; throws
* otherwise, so a public route can never act as some user by accident.
*/
export function getAuth(res: Response): AuthContext {
    const auth = res.locals.auth as AuthContext | undefined;
    if (!auth || !auth.cognitoId) {
        throw new Error("getAuth called on a request without a verified user");
    }
    return auth;
}

/*
* Authenticated http API
*
* Order: authenticate -> (admin check) -> type checks -> value checks -> route core.
* Any exception is turned into a response so no request is left hanging.
*/
export async function validateAndExecuteHttpApiRoute(
    req: Request,
    res: Response,
    pureRequestParams: RouteCheck,
    validRequestParams: RouteCheck,
    executeRouteCore: RouteCore,
    withAuth: boolean = true,
    adminOnly: boolean = false,
    userPoolId: string = COGNITO_USER_POOL_ID
    ): Promise<void> {
    try {
        if (req.body === undefined || req.body === null || typeof req.body !== "object") {
            req.body = {};
        }
        for (const key of LEGACY_IDENTITY_KEYS) {
            delete req.body[key];
        }

        if (withAuth) {
            const token = extractAccessToken(req);
            let claims: jwt.JwtPayload;
            try {
                if (!token) {
                    throw new Error("Missing access token");
                }
                claims = await verifyCognitoAccessToken(token, userPoolId);
            } catch (e) {
                if (IN_DEV) {
                    console.error("Auth failed:", (e as Error).message);
                }
                res.status(appConstants.HTTP_STATUS_CODE_UNAUTHORIZED).send({message: appConstants.HTTP_ERROR_MSG_FORBIDDEN_ACCESS});
                return;
            }
            attachIdentity(res, claims);

            if (adminOnly && !getAuth(res).isAdmin) {
                res.status(appConstants.HTTP_STATUS_CODE_FORBIDDEN).send({message: appConstants.HTTP_ERROR_MSG_ACCESS_RESTRICTED});
                return;
            }
        }

        if (!safeCheck(pureRequestParams, req)) {
            res.status(appConstants.HTTP_STATUS_CODE_BAD_REQUEST).send({message: appConstants.HTTP_ERROR_MSG_BAD_REQUEST_PARAMS});
            return;
        }
        if (!safeCheck(validRequestParams, req)) {
            res.status(appConstants.HTTP_STATUS_CODE_BAD_REQUEST).send({message: appConstants.HTTP_ERROR_MSG_INVALID_REQUEST_PARAMS});
            return;
        }

        await executeRouteCore(req, res);
    } catch (e) {
        console.error("In validateAndExecuteHttpApiRoute", e);
        if (!res.headersSent) {
            res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR});
        }
    }
}

// A check that throws (e.g. reading a property of undefined) counts as a failed check
function safeCheck(check: RouteCheck, req: Request): boolean {
    try {
        return check(req) === true;
    } catch {
        return false;
    }
}
