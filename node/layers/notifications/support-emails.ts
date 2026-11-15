import { WEBAPP_URL } from "../../config";
import { sendEmail } from "../aws/ses";
import { escapeHtml as e } from "../core/utils/validation";
import { log } from "../core/logger";

/*
 * L.8 / 8.3: tell a user Ceseelia answered their ticket. Only the subject and a link: the reply
 * is read signed in (an email can be forwarded or read by someone else). Best effort.
 */
export async function notifyTicketAnswered(to: string, ticket: { ticketId: string; subject: string }): Promise<void> {
  if (!to) return;
  const link = `${WEBAPP_URL.replace(/\/$/, "")}/merchant/support?ticket=${encodeURIComponent(ticket.ticketId)}`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">
<h1 style="margin:0 0 16px;font-size:20px">We replied to your question</h1>
<p style="margin:0 0 12px">Ceseelia support answered your ticket <strong>"${e(ticket.subject)}"</strong>.</p>
<p style="margin:0 0 12px">Sign in to read it and reply.</p>
<p style="margin:20px 0"><a href="${e(link)}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#111827;color:#ffffff;text-decoration:none;font-weight:600">Read the reply</a></p>
</div></body></html>`;
  try {
    await sendEmail(`Re: ${ticket.subject}`, "Ceseelia support", to, html);
  } catch (err) {
    log.error({ err }, "[support] reply email failed");
  }
}
