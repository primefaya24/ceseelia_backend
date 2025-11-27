// Imports
import {Request, Response, Router} from 'express';
import dotenv from 'dotenv';
import {appConstants} from "../../../../constants";
import {validateAndExecuteHttpApiRoute} from "../../../../layers/core/http";
import {IN_DEV} from "../../../../config";
import {fetchUserUUID, getMyProfile, updateUserLocale} from '../../../../layers/aws/dynamodb/dynamo-entities/user';
dotenv.config();

/*
* Request/Response interfaces
*/
interface ReqBody {
}

interface ResBody {
    profile: any;
}

/*
* Module Route
*/
module.exports = function (router: Router): void {
    router.get('/get-my-profile', (req: Request, res: Response): void => {
        validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore);
    });

    router.get('/get-my-profile/:userPreferredLocale', (req: Request, res: Response): void => {
        validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore);
    });
};

/*
* Ensure request params are pure
*/
function pureRequestParams(req: Request): boolean {
    return true;
}

/*
* Ensure request params are valid
*/
function validRequestParams(req: Request): boolean {
    return true;
}

/*
* Route controller logic
*/
async function executeRouteCore(req: Request, res: Response): Promise<void> {
    try {
        // Extract data
        const isAdmin: boolean = req.body["is_user_admin"];
        const userPreferredLocale = req.params.userPreferredLocale;

        // Get user UUID
        const userId = await fetchUserUUID(req.body["cognito_id"]);

        // Fetch user profile
        const profile = await getMyProfile(userId);
        profile.info["userIsAdmin"] = isAdmin;

        // Update locale if applicable
        if (userPreferredLocale) {
            await updateUserLocale(userId, userPreferredLocale);
        }

        // Respond to user
        res.send(profile);
    } catch (e) {
        if (IN_DEV) {
            console.error(e);
        }
        res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR});
    }
}