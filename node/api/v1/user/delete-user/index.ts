// Imports
import {Request, Response, Router} from 'express';
import dotenv from 'dotenv';
import {validateAndExecuteHttpApiRoute} from "../../../../layers/core/http";
import {appConstants} from "../../../../constants";
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
*
* Disabled (progress.md S.11). The old version deleted the Cognito login but left every DB row
* (that code was commented out), leaving orphaned profiles. A real delete needs store memberships
* (Stage 1.2): delete the DB rows and memberships, refuse while the user is the only member of a
* live store, then delete from Cognito last. Nothing in the webapp calls this route.
*/
async function executeRouteCore(req: Request, res: Response): Promise<void> {
    res.status(appConstants.HTTP_STATUS_CODE_NOT_IMPLEMENTED).send({
        message: "Account deletion isn't available yet",
    });
}
