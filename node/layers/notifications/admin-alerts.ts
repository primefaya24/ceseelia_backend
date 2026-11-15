import { ADMIN_ALERT_EMAIL, WEBAPP_URL } from "../../config";
import { sendEmail } from "../aws/ses";
import { escapeHtml as e } from "../core/utils/validation";
import { log } from "../core/logger";

/*
 * Emails to the Ceseelia team (L.2, owner 2026-11-14): when the AI store check sends a store to
 * review at Go Live, and when it hides items of a live store. To ADMIN_ALERT_EMAIL. Best effort:
 * never throws (an alert must never fail Go Live or the item check).
 */
const reviewUrl = (path = "/admin/stores") => `${WEBAPP_URL.replace(/\/$/, "")}${path}`;

function page(title: string, intro: string, lines: string[], path?: string, button = "Open the review queue"): string {
  const list = lines.map((l) => `<li style="margin:0 0 8px">${e(l)}</li>`).join("");
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">
<h1 style="margin:0 0 16px;font-size:20px">${e(title)}</h1>
<p style="margin:0 0 12px">${intro}</p>
<ul style="margin:0 0 16px;padding-left:20px;font-size:14px">${list}</ul>
<p style="margin:20px 0"><a href="${e(reviewUrl(path))}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#111827;color:#ffffff;text-decoration:none;font-weight:600">${e(button)}</a></p>
</div></body></html>`;
}

async function send(subject: string, html: string, from = "Ceseelia store check"): Promise<void> {
  try {
    if (!ADMIN_ALERT_EMAIL) return;
    await sendEmail(subject, from, ADMIN_ALERT_EMAIL, html);
  } catch (err) {
    log.error({ err }, "[admin alerts] couldn't send");
  }
}

/* Go Live sent a store to review (flagged, or the check couldn't run). */
export function notifyStoreFlagged(storeId: string, storeName: string, reasons: string[]): Promise<void> {
  return send(
    `Store to review: ${storeName || storeId}`,
    page(
      `"${storeName || storeId}" is waiting for review`,
      `It asked to go live and the store check sent it to review. It stays a draft, with no charge, until you approve it.`,
      reasons
    )
  );
}

/* The background item check hid items of a live store. */
export function notifyItemsFlagged(
  storeId: string,
  storeName: string,
  items: { name: string; reasons: string[] }[]
): Promise<void> {
  const lines = items.flatMap((i) => i.reasons.map((r) => (r.includes(i.name) ? r : `${i.name}: ${r}`)));
  return send(
    `${items.length} item(s) hidden at ${storeName || storeId}`,
    page(
      `Items hidden at "${storeName || storeId}"`,
      `The store is live. These items were added or changed and the store check hid them from shoppers until you approve or reject them. The rest of the store keeps selling.`,
      lines
    )
  );
}

const REASON_TEXT: Record<string, string> = {
  OFFENSIVE: "Offensive or abusive",
  PERSONAL_INFO: "Shares personal information",
  SPAM: "Spam or not about the store",
  OTHER: "Other (see the note)",
};

/* A merchant reported a review (L.7 / 7.5). No review text in the email: it's in the dashboard. */
export function notifyReviewReported(storeId: string, storeName: string, rating: number, reason: string): Promise<void> {
  return send(
    `Review reported at ${storeName || storeId}`,
    page(
      `A review at "${storeName || storeId}" was reported`,
      `The store asked Ceseelia to look at a ${rating}-star review. It stays live until you keep or remove it.`,
      [`Reason: ${REASON_TEXT[reason] ?? reason}`],
      "/admin/reviews",
      "Open reported reviews"
    ),
    "Ceseelia reviews"
  );
}
