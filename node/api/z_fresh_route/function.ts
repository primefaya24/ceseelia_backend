// Imports
import {Request, Response, Router} from 'express';
import dotenv from 'dotenv';
import {validateAndExecuteHttpApiRoute} from "../../layers/core/http";
import {log} from "../../layers/core/logger";
import {appConstants} from "../../constants";
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
    router.get('/path', (req: Request, res: Response): void => {
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
        const resBody: ResBody = {} as ResBody;

        // Respond to user
        res.send();
    } catch (e) {
        log.error({ err: e }, "In <area>/<route>");
        res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR});
    }
}