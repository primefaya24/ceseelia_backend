// Imports
import {Request, Response, Router} from 'express';
import dotenv from 'dotenv';
import {getAuth, validateAndExecuteHttpApiRoute} from "../../../../layers/core/http";
import {IN_DEV} from "../../../../config";
import {appConstants} from "../../../../constants";
import {fetchUserUUID, updateUserProfile} from "../../../../layers/aws/dynamodb/dynamo-entities/user";
import {sendUserLookupError} from "../user-errors";
import {MAX_LENGTH} from "../../../../constants/input-limits";
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
export default function registerRoute(router: Router): void {
    router.put('/update-profile', (req: Request, res: Response): void => {
        validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore);
    });
};

/*
* Ensure request params are pure
*/
function pureRequestParams(req: Request): boolean {
    return (
        typeof req.body.userFirstName === "string" &&
        typeof req.body.userLastName === "string"
    );
}

/*
* Ensure request params are valid
*/
function validRequestParams(req: Request): boolean {
    const ok = (name: string) => name.trim().length > 0 && name.trim().length <= MAX_LENGTH.personName;
    return ok(req.body.userFirstName) && ok(req.body.userLastName);
}

/*
* Route controller logic
*/
async function executeRouteCore(req: Request, res: Response): Promise<void> {
    try {
        // Extract params
        const userFirstName = req.body.userFirstName.trim();
        const userLastName = req.body.userLastName.trim();

        // Get user UUID
        const userId = await fetchUserUUID(getAuth(res).cognitoId);

        // Update user profile
        await updateUserProfile(userId, userFirstName, userLastName);

        // Respond to user
        res.send();
    } catch (e) {
        if (sendUserLookupError(e, res)) {
            return;
        }
        if (IN_DEV) {
            console.error(e);
        }
        res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR});
    }
}