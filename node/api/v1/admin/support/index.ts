import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { isUlid } from "../../../../layers/core/utils";
import { cleanReviewText } from "../../../../layers/aws/dynamodb/dynamo-entities/review";
import {
  TicketFullError,
  addTicketMessage,
  closeTicket,
  getTicket,
  listAllTickets,
  listTicketMessages,
} from "../../../../layers/aws/dynamodb/dynamo-entities/support-ticket";
import { notifyTicketAnswered } from "../../../../layers/notifications/support-emails";
import { fail, goodMessage, notFound, ticketFull } from "../../user/support";

/*
 * Admin › Tickets (progress.md L.8 / 8.3). Admins only.
 *   GET  /admin/support/tickets                         → { tickets, partial }
 *   GET  /admin/support/tickets/:ticketId               → { ticket, messages }
 *   POST /admin/support/tickets/:ticketId/reply { message } → { ticket }  emails the user a link
 *   POST /admin/support/tickets/:ticketId/close         → { ticket }
 * Replies are signed "Ceseelia support", never with the admin's own name.
 */
export const SUPPORT_NAME = "Ceseelia support";

export default function registerRoute(router: Router): void {
  router.get("/support/tickets", (req, res) => validateAndExecuteHttpApiRoute(req, res, () => true, () => true, list, true, true));
  router.get("/support/tickets/:ticketId", (req, res) =>
    validateAndExecuteHttpApiRoute(req, res, () => true, (r) => isUlid(r.params.ticketId), read, true, true)
  );
  router.post("/support/tickets/:ticketId/reply", (req, res) =>
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (r) => typeof r.body?.message === "string",
      (r) => isUlid(r.params.ticketId) && goodMessage(r.body.message),
      reply,
      true,
      true
    )
  );
  router.post("/support/tickets/:ticketId/close", (req, res) =>
    validateAndExecuteHttpApiRoute(req, res, () => true, (r) => isUlid(r.params.ticketId), close, true, true)
  );
}

async function list(_req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    res.send(await listAllTickets());
  } catch (e) {
    fail(res, "admin/support list")(e);
  }
}

async function read(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    const ticket = await getTicket(req.params.ticketId as string);
    if (!ticket) return void notFound(res);
    res.send({ ticket, messages: await listTicketMessages(ticket.ticketId) });
  } catch (e) {
    fail(res, "admin/support read")(e);
  }
}

async function reply(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    const found = await getTicket(req.params.ticketId as string);
    if (!found) return void notFound(res);
    const ticket = await addTicketMessage(found, "ADMIN", SUPPORT_NAME, cleanReviewText(req.body.message), Date.now());
    await notifyTicketAnswered(ticket.userEmail, ticket);
    res.send({ ticket });
  } catch (e) {
    if (e instanceof TicketFullError) return void ticketFull(res);
    fail(res, "admin/support reply")(e);
  }
}

async function close(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  try {
    const found = await getTicket(req.params.ticketId as string);
    if (!found) return void notFound(res);
    await closeTicket(found.ticketId, Date.now());
    res.send({ ticket: (await getTicket(found.ticketId)) ?? found });
  } catch (e) {
    fail(res, "admin/support close")(e);
  }
}
