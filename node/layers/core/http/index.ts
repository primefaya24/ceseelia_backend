import {appConstants} from "../../../constants";
import {Request, Response} from 'express';
import jwt from "jsonwebtoken";
import {isUserAdmin} from "../utils";
import {verifyCognitoAccessToken} from "../../aws/cognito";
import { COGNITO_USER_POOL_ID, IN_DEV } from "../../../config";

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
* Attach verified identity to the request body (kept on req.body for compatibility with existing routes)
*/
function attachIdentity(req: Request, token: string, claims: jwt.JwtPayload): void {
    const groups: string[] = Array.isArray(claims["cognito:groups"]) ? claims["cognito:groups"] : [];
    req.body["cognito_token"] = token;
    req.body["cognito_id"] = claims.sub;
    req.body["cognito_groups"] = groups;
    req.body["is_user_admin"] = isUserAdmin(groups);
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
            attachIdentity(req, token, claims);

            if (adminOnly && !req.body["is_user_admin"]) {
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
