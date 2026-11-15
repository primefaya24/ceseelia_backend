import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { MAX_LENGTH } from "../../../../constants/input-limits";
import { getAuth, validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { createRateLimiter, RateLimiter } from "../../../../layers/core/http/rate-limit";
import { isUlid } from "../../../../layers/core/utils";
import { log } from "../../../../layers/core/logger";
import { cleanReviewText } from "../../../../layers/aws/dynamodb/dynamo-entities/review";
import { getUserContact } from "../../../../layers/aws/dynamodb/dynamo-entities/user";
import { getMembership, getStoreOverviewRow } from "../../../../layers/aws/dynamodb/dynamo-entities/membership";
import {
  MAX_OPEN_TICKETS,
  SupportTicket,
  TICKET_CATEGORIES,
  TicketCategory,
  TicketFullError,
  addTicketMessage,
  closeTicket,
  createTicket,
  getTicket,
  listTicketMessages,
  listUserTickets,
} from "../../../../layers/aws/dynamodb/dynamo-entities/support-ticket";
import { notifyTicket } from "../../../../layers/notifications/admin-alerts";
import { sendUserLookupError } from "../user-errors";

/*
 * A signed-in user's support tickets (progress.md L.8 / 8.3).
 *   GET  /user/support/tickets                        → { tickets }
 *   POST /user/support/tickets { subject, category, message, storeId? } → { ticket }
 *        storeId must be a store the user is a member of. 5 new tickets a day, 10 open at once.
 *   GET  /user/support/tickets/:ticketId              → { ticket, messages }
 *   POST /user/support/tickets/:ticketId/reply { message } → { ticket }   30 replies an hour
 *   POST /user/support/tickets/:ticketId/close        → { ticket }
 * Someone else's ticket is a 404, the same as a missing one.
 */
export const createTicketLimit = createRateLimiter({ windowMs: 24 * 3600_000, max: 5 });
export const replyTicketLimit = createRateLimiter({ windowMs: 3600_000, max: 30 });
export const resetSupportLimitsForTests = () => [createTicketLimit, replyTicketLimit].forEach((l) => l.reset());

const isStr = (v: unknown): v is string => typeof v === "string";
export const cleanSubject = (s: string) => cleanReviewText(s).replace(/\s+/g, " ");
export const goodMessage = (v: unknown) => isStr(v) && cleanReviewText(v).length > 0 && v.length <= MAX_LENGTH.ticketMessage * 2 && cleanReviewText(v).length <= MAX_LENGTH.ticketMessage;

export function limitedBy(res: Response, limiter: RateLimiter, key: string): boolean {
  const r = limiter.take(key);
  if (r.ok) return false;
  res.set("Retry-After", String(r.retryAfterSeconds));
  res.status(429).send({ code: "RATE_LIMITED", message: "Too many messages. Please try again later." });
  return true;
}

export const notFound = (res: Response) => res.status(404).send({ code: "TICKET_NOT_FOUND", message: "That ticket doesn't exist." });
export const ticketFull = (res: Response) =>
  res.status(409).send({ code: "TICKET_FULL", message: "This ticket has too many messages. Please open a new one." });

export const fail = (res: Response, where: string) => (e: unknown) => {
  if (sendUserLookupError(e, res)) return;
  log.error({ err: e }, `In ${where}`);
  res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
};

/** What a user sees of their ticket (the team's view adds who they are). */
export const userTicketView = (t: SupportTicket) => {
  const { userId: _u, userEmail: _e, ...rest } = t;
  return rest;
};

export default function registerRoute(router: Router): void {
  router.get("/support/tickets", (req, res) => validateAndExecuteHttpApiRoute(req, res, () => true, () => true, list));
  router.post("/support/tickets", (req, res) =>
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (r) => isStr(r.body?.subject) && isStr(r.body?.category) && isStr(r.body?.message) && (r.body.storeId === undefined || r.body.storeId === null || isStr(r.body.storeId)),
      (r) => {
        const subject = cleanSubject(r.body.subject);
        return (
          subject.length > 0 &&
          subject.length <= MAX_LENGTH.ticketSubject &&
          (TICKET_CATEGORIES as readonly string[]).includes(r.body.category) &&
          goodMessage(r.body.message) &&
          (!r.body.storeId || isUlid(r.body.storeId))
        );
      },
      create
    )
  );
  router.get("/support/tickets/:ticketId", (req, res) => validateAndExecuteHttpApiRoute(req, res, () => true, (r) => isUlid(r.params.ticketId), read));
  router.post("/support/tickets/:ticketId/reply", (req, res) =>
    validateAndExecuteHttpApiRoute(req, res, (r) => isStr(r.body?.message), (r) => isUlid(r.params.ticketId) && goodMessage(r.body.message), reply)
  );
  router.post("/support/tickets/:ticketId/close", (req, res) => validateAndExecuteHttpApiRoute(req, res, () => true, (r) => isUlid(r.params.ticketId), close));
}

async function list(_req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    const me = await getUserContact(getAuth(res).cognitoId);
    res.send({ tickets: (await listUserTickets(me.userId)).map(userTicketView) });
  } catch (e) {
    fail(res, "user/support list")(e);
  }
}

async function create(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    const me = await getUserContact(getAuth(res).cognitoId);
    let storeId: string | null = null;
    let storeName: string | null = null;
    if (req.body.storeId) {
      // Only a store the user belongs to (else it reads like a missing store).
      if (!(await getMembership(req.body.storeId, me.userId))) {
        res.status(400).send({ code: "STORE_NOT_YOURS", message: "Pick one of your stores." });
        return;
      }
      storeId = req.body.storeId;
      storeName = String((await getStoreOverviewRow(req.body.storeId))?.storeName ?? "") || null;
    }
    const mine = await listUserTickets(me.userId);
    if (mine.filter((t) => t.status !== "CLOSED").length >= MAX_OPEN_TICKETS) {
      res.status(409).send({ code: "TOO_MANY_OPEN", message: "You have many open tickets. Please close some before opening another." });
      return;
    }
    if (limitedBy(res, createTicketLimit, `user:${me.userId}`)) return;
    const ticket = await createTicket({
      userId: me.userId,
      userEmail: me.email,
      userName: me.name || me.email,
      storeId,
      storeName,
      subject: cleanSubject(req.body.subject),
      category: req.body.category as TicketCategory,
      body: cleanReviewText(req.body.message),
      now: Date.now(),
    });
    await notifyTicket(ticket, "NEW");
    res.send({ ticket: userTicketView(ticket) });
  } catch (e) {
    fail(res, "user/support create")(e);
  }
}

/** The ticket if it's this user's, else null. */
async function ownTicket(res: Response, ticketId: string): Promise<{ ticket: SupportTicket; name: string } | null> {
  const me = await getUserContact(getAuth(res).cognitoId);
  const ticket = await getTicket(ticketId);
  return ticket && ticket.userId === me.userId ? { ticket, name: me.name || me.email } : null;
}

async function read(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    const own = await ownTicket(res, req.params.ticketId as string);
    if (!own) return void notFound(res);
    res.send({ ticket: userTicketView(own.ticket), messages: await listTicketMessages(own.ticket.ticketId) });
  } catch (e) {
    fail(res, "user/support read")(e);
  }
}

async function reply(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    const own = await ownTicket(res, req.params.ticketId as string);
    if (!own) return void notFound(res);
    if (limitedBy(res, replyTicketLimit, `user:${own.ticket.userId}`)) return;
    const ticket = await addTicketMessage(own.ticket, "USER", own.name, cleanReviewText(req.body.message), Date.now());
    await notifyTicket(ticket, "REPLY");
    res.send({ ticket: userTicketView(ticket) });
  } catch (e) {
    if (e instanceof TicketFullError) return void ticketFull(res);
    fail(res, "user/support reply")(e);
  }
}

async function close(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    const own = await ownTicket(res, req.params.ticketId as string);
    if (!own) return void notFound(res);
    await closeTicket(own.ticket.ticketId, Date.now());
    res.send({ ticket: userTicketView((await getTicket(own.ticket.ticketId)) ?? own.ticket) });
  } catch (e) {
    fail(res, "user/support close")(e);
  }
}
