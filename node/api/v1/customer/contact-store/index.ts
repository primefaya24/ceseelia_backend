// Imports
import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { appConstants } from "../../../../constants";
import { MAX_LENGTH } from "../../../../constants/input-limits";
import { getPublicStoreSettings } from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { sendEmail } from "../../../../layers/aws/ses";
import { sendPublicError } from "../../../../layers/core/http/public-storefront";
import { createRateLimiter } from "../../../../layers/core/http/rate-limit";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { getClientIp, isUlid } from "../../../../layers/core/utils";
import { escapeHtml, isEmailOrEmpty } from "../../../../layers/core/utils/validation";

/*
 * POST /customer/contact-store (public, no auth; progress.md 3.4 / WA 3.3b)
 * Body { storeId, name, email, message, website }. Emails the store's contact address from our
 * own address with the customer's email as Reply-To (never as From, so it can't be spoofed).
 *   - `website` is a honeypot: people never see it, bots fill it in. A filled one gets the same
 *     200 as a real send, but nothing is sent.
 *   - Rate limits: 5 per IP per 10 minutes and 30 per store per hour (429 RATE_LIMITED with
 *     Retry-After).
 *   - 409 CONTACT_UNAVAILABLE when the store has no contact email; the store's 404s otherwise.
 */
export const contactLimits = {
  perIp: createRateLimiter({ windowMs: 10 * 60_000, max: 5 }),
  perStore: createRateLimiter({ windowMs: 60 * 60_000, max: 30 }),
};

export default function registerRoute(router: Router): void {
  router.post("/contact-store", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore, false);
  });
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
// No control characters (they'd break the subject line or headers); newlines only in the message
// eslint-disable-next-line no-control-regex
const hasControlChars = (s: string) => /[\u0000-\u001f\u007f]/.test(s);

function pureRequestParams(req: Request): boolean {
  const b = req.body;
  return (
    typeof b.storeId === "string" &&
    typeof b.name === "string" &&
    typeof b.email === "string" &&
    typeof b.message === "string" &&
    (b.website === undefined || typeof b.website === "string")
  );
}

function validRequestParams(req: Request): boolean {
  const name = text(req.body.name);
  const email = text(req.body.email);
  const message = text(req.body.message);
  return (
    isUlid(req.body.storeId) &&
    name.length > 0 &&
    name.length <= MAX_LENGTH.personName &&
    !hasControlChars(name) &&
    email.length > 0 &&
    email.length <= MAX_LENGTH.email &&
    isEmailOrEmpty(email) &&
    !hasControlChars(email) &&
    message.length > 0 &&
    message.length <= MAX_LENGTH.contactMessage &&
    !hasControlChars(message.replace(/\r?\n|\t/g, " "))
  );
}

function tooMany(res: Response, retryAfterSeconds: number): void {
  res.set("Retry-After", String(retryAfterSeconds));
  res.status(429).send({
    code: "RATE_LIMITED",
    message: "Too many messages. Please try again later.",
    retryAfter: retryAfterSeconds,
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const storeId = String(req.body.storeId);
  const ipCheck = contactLimits.perIp.take(`ip:${getClientIp(req) ?? "unknown"}`);
  if (!ipCheck.ok) {
    tooMany(res, ipCheck.retryAfterSeconds);
    return;
  }
  if (text(req.body.website)) {
    res.send({ sent: true });
    return;
  }
  try {
    const settings = await getPublicStoreSettings(storeId);
    const to = settings.storeInfo?.emailaddress?.trim() ?? "";
    if (!to) {
      res
        .status(appConstants.HTTP_STATUS_CODE_CONFLICT)
        .send({ code: "CONTACT_UNAVAILABLE", message: "This store can't be contacted by email yet." });
      return;
    }
    const storeCheck = contactLimits.perStore.take(`store:${storeId}`);
    if (!storeCheck.ok) {
      tooMany(res, storeCheck.retryAfterSeconds);
      return;
    }
    const name = text(req.body.name);
    const email = text(req.body.email);
    const message = text(req.body.message);
    const storeName = settings.storeInfo?.storeName || "your store";
    const html = `
      <p>You have a new message from a customer of <strong>${escapeHtml(storeName)}</strong>.</p>
      <p><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>
      <p style="white-space: pre-wrap">${escapeHtml(message).replace(/\r?\n/g, "<br>")}</p>
      <p>Reply to this email to answer them.</p>`;
    const sent = await sendEmail(`Message from ${name} via your Ceseelia store`, "Ceseelia", to, html, false, email);
    if (!sent) {
      res
        .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
        .send({ code: "SEND_FAILED", message: "We couldn't send your message. Please try again later." });
      return;
    }
    res.send({ sent: true });
  } catch (e) {
    sendPublicError(res, e);
  }
}
