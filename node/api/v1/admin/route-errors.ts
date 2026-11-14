import { Response } from "express";
import { appConstants } from "../../../constants";
import { MembershipError } from "../../../layers/aws/dynamodb/dynamo-entities/membership";

const STATUS: Record<MembershipError["reason"], number> = {
  STORE_NOT_FOUND: appConstants.HTTP_STATUS_CODE_NOT_FOUND,
  USER_NOT_FOUND: appConstants.HTTP_STATUS_CODE_NOT_FOUND,
  NOT_A_MEMBER: appConstants.HTTP_STATUS_CODE_NOT_FOUND,
  NOT_INVITED: appConstants.HTTP_STATUS_CODE_NOT_FOUND,
  ALREADY_MEMBER: appConstants.HTTP_STATUS_CODE_CONFLICT,
  ALREADY_IN_A_STORE: appConstants.HTTP_STATUS_CODE_CONFLICT,
};

/* Answer a MembershipError with its status and `code` (the reason). Returns true if it responded. */
export function sendMembershipError(e: unknown, res: Response): boolean {
  if (!(e instanceof MembershipError)) return false;
  res.status(STATUS[e.reason]).send({ message: e.message, code: e.reason });
  return true;
}

export function sendServerError(e: unknown, res: Response, where: string): void {
  console.error(where, e);
  res
    .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
    .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
}
