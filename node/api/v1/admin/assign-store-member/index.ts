import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { MAX_LENGTH } from "../../../../constants/input-limits";
import { WEBAPP_URL } from "../../../../config";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { isUlid } from "../../../../layers/core/utils";
import { isEmailOrEmpty } from "../../../../layers/core/utils/validation";
import { sendEmail } from "../../../../layers/aws/ses";
import { peekUserByEmail } from "../../../../layers/aws/dynamodb/dynamo-entities/user";
import {
  addStoreMember,
  getStoreOverviewRow,
  inviteStoreMember,
  normalizeEmail,
  STORE_ROLES,
  StoreRole,
} from "../../../../layers/aws/dynamodb/dynamo-entities/membership";
import { sendMembershipError, sendServerError } from "../route-errors";

/*
 * POST /admin/assign-store-member (admin, progress.md 1.4b)
 * Body: { storeId, email, role? = "MERCHANT" }
 * → { result: "ADDED", userId, role }              the email has an account: member now
 * → { result: "INVITED", email, role, emailSent }  no account: pending invite + invite email;
 *                                                  joins on their first sign-in (1.4c)
 * 404 STORE_NOT_FOUND · 409 ALREADY_MEMBER
 */
export default function registerRoute(router: Router): void {
  router.post("/assign-store-member", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore, true, /* admins only */ true);
  });
}

function pureRequestParams(req: Request): boolean {
  const { storeId, email, role } = req.body;
  return isUlid(storeId) && typeof email === "string" && (role === undefined || typeof role === "string");
}

function validRequestParams(req: Request): boolean {
  const { email, role } = req.body;
  const trimmed = email.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_LENGTH.email &&
    isEmailOrEmpty(trimmed) &&
    (role === undefined || STORE_ROLES.includes(role))
  );
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const storeId: string = req.body.storeId;
    const email = normalizeEmail(req.body.email);
    const role: StoreRole = req.body.role ?? appConstants.STORE_MEMBER_PERMISSION_MERCHANT;

    const store = await getStoreOverviewRow(storeId);
    if (!store) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ message: "Store not found", code: "STORE_NOT_FOUND" });
      return;
    }

    // Existing account: add them now
    const rows: any[] = (await peekUserByEmail(email)) ?? [];
    if (rows.length > 0) {
      const userId: string = rows[0].pk.split("#")[1];
      await addStoreMember(storeId, userId, role);
      res.send({ result: "ADDED", userId, role });
      return;
    }

    // No account yet: pending invite, claimed when they first sign in
    await inviteStoreMember(storeId, email, role);
    const emailSent = await sendInviteEmail(email, String(store.storeName ?? ""));
    res.send({ result: "INVITED", email, role, emailSent });
  } catch (e) {
    if (!sendMembershipError(e, res)) {
      sendServerError(e, res, "In assign-store-member");
    }
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/* The invite is saved either way; a failed email is reported so the admin can resend. */
export async function sendInviteEmail(email: string, storeName: string): Promise<boolean> {
  const name = escapeHtml(storeName || "a store");
  // ?email= prefills the sign-up form with the invited address (WA sign-up page)
  const signUpUrl = `${WEBAPP_URL}/auth/sign-up?email=${encodeURIComponent(email)}`;
  const html = `
    <p>Hello,</p>
    <p>You've been invited to manage <strong>${name}</strong> on Ceseelia.</p>
    <p>Create your account with this email address (${escapeHtml(email)}) and the store will be
    waiting for you when you sign in:</p>
    <p><a href="${escapeHtml(signUpUrl)}">Create your account</a></p>
    <p>If you weren't expecting this, you can ignore this email.</p>`;
  const result = await sendEmail(`You're invited to manage ${storeName || "a store"} on Ceseelia`, "Ceseelia", email, html);
  return result !== undefined;
}
