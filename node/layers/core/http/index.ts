import {appConstants} from "../../../constants";
import {Request, Response} from 'express';
import {isUserAdmin} from "../utils";
import {isCognitoTokenValid} from "../../aws/cognito";
import { COGNITO_USER_POOL_ID } from "../../../config";
const jwt = require('jsonwebtoken');

////////////////////////////////////////
// Add Cognito Token to reqBody
////////////////////////////////////////
function addCognitoTokenToReqBody(
    req: Request,
    ): void {
    // Ensure reqBody is valid
    if (typeof req.body === "undefined") {
        req.body = {};
    }
    // Attach access token
    if (typeof req.headers.authorization === "undefined") {
        // Running on local-api
        req.body["cognito_token"] = req.headers.Authorization;
    }
    else {
        // Running in the cloud
        req.body["cognito_token"] = req.headers.authorization;
    }

    // Attach id token if given
    if ((typeof req.headers.id === "string") || (typeof req.headers.Id === "string")) {
        if (typeof req.headers.id === "undefined") {
            // Running on local-api
            req.body["cognito_id_token"] = req.headers.Id;
        }
        else {
            // Running in the cloud
            req.body["cognito_id_token"] = req.headers.id;
        }
    }

    // Attach cognito group
    if (req.body["cognito_token"]) {
        const decodedToken = jwt.decode(req.body["cognito_token"]);
        req.body["cognito_id"] = decodedToken["sub"];
        if (decodedToken) {
            req.body["cognito_groups"] = decodedToken["cognito:groups"] ?? [];
        }
        req.body["is_user_admin"] = isUserAdmin(req.body["cognito_groups"]);
    }
}

/*
* Authenticated http API
*/
export async function validateAndExecuteHttpApiRoute(
    req: Request,
    res: Response,
    pureRequestParams: any,
    validRequestParams: any,
    executeRouteCore: any,
    withAuth: boolean = true,
    adminOnly: boolean = false,
    userPoolId: string = COGNITO_USER_POOL_ID
    ): Promise<void> {
    if (pureRequestParams(req)) {
        if (validRequestParams(req)) {
            if (withAuth) {
                addCognitoTokenToReqBody(req);
                if (await isCognitoTokenValid(req.body["cognito_token"], userPoolId)) {
                    if (adminOnly) {
                        if (req.body["is_user_admin"]) {
                            executeRouteCore(req, res);
                        } else {
                            res.status(appConstants.HTTP_STATUS_CODE_FORBIDDEN).send({message: appConstants.HTTP_ERROR_MSG_ACCESS_RESTRICTED});
                        }
                    } else {
                        executeRouteCore(req, res);
                    }
                } else {
                    res.status(appConstants.HTTP_STATUS_CODE_FORBIDDEN).send({message: appConstants.HTTP_ERROR_MSG_FORBIDDEN_ACCESS});
                }
            } else {
                executeRouteCore(req, res);
            }
        } else {
            res.status(appConstants.HTTP_STATUS_CODE_BAD_REQUEST).send({message: appConstants.HTTP_ERROR_MSG_INVALID_REQUEST_PARAMS});
        }
    } else {
        res.status(appConstants.HTTP_STATUS_CODE_BAD_REQUEST).send({message: appConstants.HTTP_ERROR_MSG_BAD_REQUEST_PARAMS});
    }
}
