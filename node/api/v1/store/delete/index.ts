// Imports
import {Request, Response, Router} from 'express';
import dotenv from 'dotenv';
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import {appConstants} from "../../../../constants";
import { isUlid } from "../../../../layers/core/utils";
import { deleteStore } from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { getStoreBillingState } from "../../../../layers/aws/dynamodb/dynamo-entities/billing";
import { cancelSubscriptionNow } from "../../../../layers/payments/billing";
import { sendPaymentsError } from "../payments/errors";
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
    router.delete('/delete/:storeId', (req: Request, res: Response): void => {
        validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore, true, /* admins only */ true);
    });
};

/*
* Ensure request params are pure
*/
function pureRequestParams(req: Request): boolean {
    return isUlid(req.params.storeId);
}

/*
* Ensure request params are valid
*/
function validRequestParams(req: Request): boolean {
    return true;
}

/*
* Route controller logic: delete the store and everything in it (progress.md 1.7).
* → { deleted: true } · 404 STORE_NOT_FOUND when there's nothing left. Safe to call again
* after a failure: each run deletes whatever is still there.
*/
async function executeRouteCore(req: Request, res: Response): Promise<void> {
    try {
        // P.5: stop the store's subscription first, so nobody is billed for a deleted store.
        // If Stripe can't be reached, nothing is deleted (502; try again).
        const billing = await getStoreBillingState(req.params.storeId as string);
        const sub = billing?.subscription;
        if (sub && !["canceled", "incomplete_expired"].includes(sub.status)) {
            try {
                await cancelSubscriptionNow(sub.subscriptionId);
            } catch (e) {
                sendPaymentsError(e, res, "In store/delete (cancelling the subscription)");
                return;
            }
        }
        const found = await deleteStore(req.params.storeId as string);
        if (!found) {
            res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({message: "Store not found", code: "STORE_NOT_FOUND"});
            return;
        }
        res.send({deleted: true});
    } catch (e) {
        console.error("In store/delete", e);
        res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR});
    }
}
