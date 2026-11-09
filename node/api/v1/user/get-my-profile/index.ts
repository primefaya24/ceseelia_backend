// Imports
import {Request, Response, Router} from 'express';
import dotenv from 'dotenv';
import {appConstants} from "../../../../constants";
import {getAuth, validateAndExecuteHttpApiRoute} from "../../../../layers/core/http";
import {IN_DEV} from "../../../../config";
import {
    createUserRecordsFromCognito,
    findUserIdByCognitoId,
    getMyProfile,
    ProfileNotFoundError,
    updateUserLocale,
} from '../../../../layers/aws/dynamodb/dynamo-entities/user';
import {getCognitoUserAttributes} from "../../../../layers/aws/cognito";
import {sendUserLookupError} from "../user-errors";
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
export default function registerRoute(router: Router): void {
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
    // The optional locale is saved on the profile, so only accept supported ones.
    const locale = req.params.userPreferredLocale;
    return locale === undefined || appConstants.SUPPORTED_LOCALES.includes(locale);
}

/*
* Route controller logic
*/
async function executeRouteCore(req: Request, res: Response): Promise<void> {
    try {
        // Extract data
        const { cognitoId, isAdmin } = getAuth(res);
        const userPreferredLocale = req.params.userPreferredLocale;

        // Get user UUID. The OnUserRegister Lambda normally created the rows at sign-up; if its write
        // failed, create them now from the user pool's verified attributes (progress.md 1.1d).
        let userId = await findUserIdByCognitoId(cognitoId);
        if (!userId) {
            const attrs = await getCognitoUserAttributes(cognitoId);
            userId = attrs ? await createUserRecordsFromCognito(attrs) : null;
            if (!userId) {
                throw new ProfileNotFoundError();
            }
        }

        // Fetch user profile
        const profile = await getMyProfile(userId);
        if (!profile.info) {
            throw new ProfileNotFoundError();
        }
        profile.info["userIsAdmin"] = isAdmin;

        // Update locale if applicable
        if (userPreferredLocale) {
            await updateUserLocale(userId, userPreferredLocale);
        }

        // Respond to user
        res.send(profile);
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