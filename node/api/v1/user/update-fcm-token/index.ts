// Imports
import {Request, Response, Router} from 'express';
import dotenv from 'dotenv';
import {appConstants} from "../../../../constants";
import {validateAndExecuteHttpApiRoute} from "../../../../layers/core/http";
import {IN_DEV} from "../../../../config";
import {fetchUserUUID, updateFcmToken} from '../../../../layers/aws/dynamodb/dynamo-entities/user';
dotenv.config();

/*
* Request/Response interfaces
*/
interface ReqBody {
}

interface ResBody {
}

/*
* Module Route
*/
module.exports = function (router: Router): void {
    router.put('/update-fcm-token', (req: Request, res: Response): void => {
        validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore);
    });
};

/*
* Ensure request params are pure
*/
function pureRequestParams(req: Request): boolean {
    return typeof req.body.fcmToken === "string";
}

/*
* Ensure request params are valid
*/
function validRequestParams(req: Request): boolean {
    return req.body.fcmToken.length !== 0;
}

/*
* Route controller logic
*/
async function executeRouteCore(req: Request, res: Response): Promise<void> {
    try {
        // Get user UUID
        const userId = await fetchUserUUID(req.body["cognito_id"]);

        // Update FCM token for this user
        await updateFcmToken(userId, req.body.fcmToken);

        // Respond to user
        res.send();
    } catch (e) {
        if (IN_DEV) {
            console.error(e);
        }
        res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR});
    }
}