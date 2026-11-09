import { Response } from "express";
import { appConstants } from "../../../constants";
import {
    ProfileNotFoundError,
    UserDeactivatedError,
} from "../../../layers/aws/dynamodb/dynamo-entities/user";

export const PROFILE_NOT_FOUND = "PROFILE_NOT_FOUND";
export const ACCOUNT_DEACTIVATED = "ACCOUNT_DEACTIVATED";

/*
 * Answer for the user-lookup errors every /user route can hit. Returns true if it responded.
 * `code` lets the webapp tell "no profile" apart from other failures (WA 1.1).
 */
export function sendUserLookupError(e: unknown, res: Response): boolean {
    if (e instanceof ProfileNotFoundError) {
        res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: e.message, code: PROFILE_NOT_FOUND });
        return true;
    }
    if (e instanceof UserDeactivatedError) {
        res.status(appConstants.HTTP_STATUS_CODE_FORBIDDEN).send({ message: e.message, code: ACCOUNT_DEACTIVATED });
        return true;
    }
    return false;
}
