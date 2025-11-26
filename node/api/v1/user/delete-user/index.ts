// Imports
import {Request, Response, Router} from 'express';
import dotenv from 'dotenv';
import {validateAndExecuteHttpApiRoute} from "../../../../layers/core/http";
import {IN_DEV, S3_STORAGE_BUCKET_NAME} from "../../../../config";
import {appConstants} from "../../../../constants";
import {deleteUserDB, fetchUserCognitoItems, fetchUserUUID} from "../../../../layers/aws/dynamodb/dynamo-entities/user";
import {deleteUser} from "../../../../layers/aws/cognito";
import {deleteS3FilesPrefixed} from "../../../../layers/aws/s3";
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
    router.delete('/delete-user', (req: Request, res: Response): void => {
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
        // Prepare response body
        const resBody: ResBody = {};

        // Get user
        const userDoc = await fetchUserUUID(req.body["cognito_id"], false);
        const userId = userDoc["pk"].split("#")[1];
        const userEmail = userDoc["userEmail"];

        // Delete cognito records
        const userCognitoData: any[] = await fetchUserCognitoItems(userId);
        await deleteUser(userCognitoData);

        // Delete DB records
        const userWebsiteIds: any[] = await deleteUserDB(userId, userEmail);

        // Delete s3 assets
        const allS3DeletePromises: Promise<void>[] = userWebsiteIds.map(userWebsiteId => deleteS3FilesPrefixed(S3_STORAGE_BUCKET_NAME, `website/${userWebsiteId}/`));
        await Promise.all(allS3DeletePromises);

        // Respond to user
        res.send();
    } catch (e) {
        if (IN_DEV) {
            console.error(e);
        }
        res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR});
    }
}