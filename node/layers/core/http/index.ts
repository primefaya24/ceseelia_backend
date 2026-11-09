import {appConstants} from "../../../constants";
import {Request, Response} from 'express';
import jwt from "jsonwebtoken";
import {isUserAdmin} from "../utils";
import {verifyCognitoAccessToken} from "../../aws/cognito";
import { COGNITO_USER_POOL_ID, IN_DEV } from "../../../config";
import { isUlid } from "../utils";
import { findUserIdByCognitoId, UserDeactivatedError } from "../../aws/dynamodb/dynamo-entities/user";
import { getMembership, StoreRole } from "../../aws/dynamodb/dynamo-entities/membership";

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
    /* Set by the store-access check for members (not for admins, who skip the lookup). */
    userId?: string;
    storeRole?: StoreRole;
}

/*
* Who may call a route, as the wrapper's `access` argument:
*   false           any signed-in user (or anyone, with withAuth=false)
*   true            admins only
*   storeMember(…)  admins, or members of the store the request names (progress.md 1.3)
*/
export interface StoreAccessRule {
    storeId: (req: Request) => unknown;
    /* Minimum store role. ADMIN > MERCHANT. Omit for any member. */
    role?: StoreRole;
}
export type RouteAccess = boolean | StoreAccessRule;

/* Every /store/** route except create/delete: `storeMember((req) => req.params.storeId)`. */
export function storeMember(storeId: (req: Request) => unknown, role?: StoreRole): StoreAccessRule {
    return { storeId, role };
}

const ROLE_RANK: Record<StoreRole, number> = { MERCHANT: 1, ADMIN: 2 };
export const STORE_ACCESS_DENIED = "STORE_ACCESS_DENIED";

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
* Store-access check. Admins always pass. Anyone else needs a membership of `storeId` with at
* least `role`; the role is kept in `res.locals.auth`. Sends the response and returns false when
* access is refused: 400 for a malformed store id, 403 when not a member or deactivated.
*/
export async function assertStoreAccess(
    res: Response,
    storeId: unknown,
    role?: StoreRole
): Promise<boolean> {
    const auth = getAuth(res);
    if (!isUlid(storeId)) {
        res.status(appConstants.HTTP_STATUS_CODE_BAD_REQUEST).send({message: appConstants.HTTP_ERROR_MSG_BAD_REQUEST_PARAMS});
        return false;
    }
    if (auth.isAdmin) {
        return true;
    }
    let userId: string | null;
    try {
        userId = await findUserIdByCognitoId(auth.cognitoId);
    } catch (e) {
        if (e instanceof UserDeactivatedError) {
            res.status(appConstants.HTTP_STATUS_CODE_FORBIDDEN).send({message: e.message, code: "ACCOUNT_DEACTIVATED"});
            return false;
        }
        throw e;
    }
    const membership = userId ? await getMembership(storeId as string, userId) : null;
    if (!membership || (role && ROLE_RANK[membership.role] < ROLE_RANK[role])) {
        res.status(appConstants.HTTP_STATUS_CODE_FORBIDDEN).send({message: appConstants.HTTP_ERROR_MSG_ACCESS_RESTRICTED, code: STORE_ACCESS_DENIED});
        return false;
    }
    auth.userId = userId!;
    auth.storeRole = membership.role;
    return true;
}

/*
* Authenticated http API
*
* Order: authenticate (401) -> access: admin-only or store member (403) -> type checks (400)
*        -> value checks (400) -> route core.
* Any exception is turned into a response so no request is left hanging.
*/
export async function validateAndExecuteHttpApiRoute(
    req: Request,
    res: Response,
    pureRequestParams: RouteCheck,
    validRequestParams: RouteCheck,
    executeRouteCore: RouteCore,
    withAuth: boolean = true,
    access: RouteAccess = false,
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

            if (access === true && !getAuth(res).isAdmin) {
                res.status(appConstants.HTTP_STATUS_CODE_FORBIDDEN).send({message: appConstants.HTTP_ERROR_MSG_ACCESS_RESTRICTED});
                return;
            }
            if (typeof access === "object") {
                let storeId: unknown;
                try {
                    storeId = access.storeId(req);
                } catch {
                    storeId = undefined;
                }
                if (!(await assertStoreAccess(res, storeId, access.role))) {
                    return;
                }
            }
        } else if (access !== false) {
            throw new Error("Route access rules need withAuth=true");
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
