import { StoreOrder, StoreOrderStatus } from "../core/interfaces/store";
import { escapeHtml } from "../core/utils/validation";

/*
 * Order emails (progress.md 6.5), as pure functions: subject + HTML, no I/O. Sent by
 * `order-emails.ts`. Plain, table-free HTML with inline styles so it reads in every client.
 * Shopper emails come "from" the store (`<Store> via Ceseelia`, replies to the store's email);
 * the platform fee is never shown to shoppers (5.1).
 */

export interface EmailStore {
  storeName: string;
  /** The store's contact email (Reply-To for shopper emails), or "". */
  storeEmail: string;
  pickupAddress: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

const LOCALES: Record<string, string> = { CAD: "en-CA", USD: "en-US", AUD: "en-AU" };

export function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(LOCALES[currency] ?? "en-CA", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

const e = escapeHtml;
const p = (html: string) => `<p style="margin:0 0 12px">${html}</p>`;
const button = (href: string, label: string) =>
  `<p style="margin:20px 0"><a href="${e(href)}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#111827;color:#ffffff;text-decoration:none;font-weight:600">${e(label)}</a></p>`;

function layout(title: string, body: string, footer: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">
<h1 style="margin:0 0 16px;font-size:20px">${title}</h1>
${body}
</div>
<p style="max-width:560px;margin:12px auto 0;font-size:12px;color:#6b7280">${footer}</p>
</body></html>`;
}

const shopperFooter = (store: EmailStore) =>
  `${e(store.storeName)} uses Ceseelia for online orders.${store.storeEmail ? " Reply to this email to reach the store." : ""}`;

function linesTable(o: StoreOrder, withTotals: boolean): string {
  const c = o.storeOrderCurrency;
  const row = (left: string, right: string, strong = false) =>
    `<tr><td style="padding:4px 0;${strong ? "font-weight:700" : ""}">${left}</td><td style="padding:4px 0;text-align:right;white-space:nowrap;${strong ? "font-weight:700" : ""}">${right}</td></tr>`;
  const items = o.storeOrderLines
    .map((l) => {
      const picks = l.params.map((x) => x.values.join(", ")).filter(Boolean).join(" · ");
      return row(`${l.quantity} × ${e(l.itemName)}${picks ? `<br><span style="color:#6b7280;font-size:13px">${e(picks)}</span>` : ""}`, money(l.totalMinor, c));
    })
    .join("");
  let totals = "";
  if (withTotals) {
    // The lines are after their discounts, so the subtotal is too; the saving is shown apart.
    totals += row("Subtotal", money(o.storeOrderSubtotalMinor - o.storeOrderDiscountMinor, c));
    if (o.storeOrderDiscountMinor > 0) totals += row(`<span style="color:#047857">You saved</span>`, `<span style="color:#047857">${money(o.storeOrderDiscountMinor, c)}</span>`);
    if (o.storeOrderDeliveryMinor > 0) totals += row("Delivery", money(o.storeOrderDeliveryMinor, c));
    for (const t of o.storeOrderTaxLines ?? []) {
      if (t.minor > 0) totals += row(`${e(t.label)} ${t.percent}%${o.storeOrderPricesIncludeTax ? " (included)" : ""}`, money(t.minor, c));
    }
    totals += row("Total", money(o.storeOrderTotalMinor, c), true);
  }
  return `<table style="width:100%;border-collapse:collapse;margin:0 0 16px;font-size:14px">${items}${
    totals ? `<tr><td colspan="2" style="border-top:1px solid #e5e7eb;padding-top:4px"></td></tr>${totals}` : ""
  }</table>`;
}

function fulfilment(o: StoreOrder, store: EmailStore): string {
  if (o.storeOrderType === "DELIVERY" && o.storeOrderAddress) {
    const a = o.storeOrderAddress;
    return p(`<strong>Delivering to:</strong><br>${e(a.line1)}${a.line2 ? `, ${e(a.line2)}` : ""}<br>${e(a.city)}, ${e(a.region)} ${e(a.postalCode)}<br>${e(a.country)}`);
  }
  return p(`<strong>Pickup</strong>${store.pickupAddress ? ` at ${e(store.pickupAddress)}` : ""}. The store will let you know when it's ready.`);
}

/* The shopper's receipt, once the order is paid. */
export function receiptEmail(o: StoreOrder, store: EmailStore, orderUrl: string): RenderedEmail {
  return {
    subject: `Your order ${o.storeOrderCode} from ${store.storeName}`,
    html: layout(
      `Thanks for your order, ${e(o.storeOrderCustomer.name.split(" ")[0] || "there")}!`,
      [
        p(`<strong>${e(store.storeName)}</strong> has your order <strong>${e(o.storeOrderCode)}</strong>, and your payment went through.`),
        linesTable(o, true),
        fulfilment(o, store),
        o.storeOrderNote ? p(`<strong>Your note:</strong> ${e(o.storeOrderNote)}`) : "",
        button(orderUrl, "View your order"),
        p(`<span style="color:#6b7280;font-size:13px">Keep this email: the link shows your order on any device. Don't share it.</span>`),
      ].join(""),
      shopperFooter(store)
    ),
  };
}

/* Which merchant steps the shopper hears about (6.5): pickup ready, delivery on its way. */
export function statusEmailFor(o: Pick<StoreOrder, "storeOrderType">, to: StoreOrderStatus): "READY" | "SHIPPED" | null {
  if (to === "READY" && o.storeOrderType === "PICKUP") return "READY";
  if (to === "SHIPPED" && o.storeOrderType === "DELIVERY") return "SHIPPED";
  return null;
}

export function statusEmail(o: StoreOrder, store: EmailStore, kind: "READY" | "SHIPPED", orderUrl: string): RenderedEmail {
  const ready = kind === "READY";
  return {
    subject: ready ? `Your order ${o.storeOrderCode} is ready for pickup` : `Your order ${o.storeOrderCode} is on its way`,
    html: layout(
      ready ? "Your order is ready for pickup" : "Your order is on its way",
      [
        p(
          ready
            ? `<strong>${e(store.storeName)}</strong> has order <strong>${e(o.storeOrderCode)}</strong> ready for you${store.pickupAddress ? ` at ${e(store.pickupAddress)}` : ""}. Mention the code when you pick it up.`
            : `<strong>${e(store.storeName)}</strong> has sent order <strong>${e(o.storeOrderCode)}</strong>.`
        ),
        linesTable(o, false),
        button(orderUrl, "View your order"),
      ].join(""),
      shopperFooter(store)
    ),
  };
}

/* A refund reached the order (ours or from the store's Stripe dashboard). */
export function refundEmail(o: StoreOrder, store: EmailStore, amountMinor: number, full: boolean, orderUrl: string): RenderedEmail {
  const c = o.storeOrderCurrency;
  const refunded = o.storeOrderRefundedMinor ?? amountMinor;
  return {
    subject: full ? `Your order ${o.storeOrderCode} was refunded` : `A refund of ${money(amountMinor, c)} for order ${o.storeOrderCode}`,
    html: layout(
      full ? "Your order was refunded" : "You've been refunded part of your order",
      [
        p(`<strong>${e(store.storeName)}</strong> refunded <strong>${money(amountMinor, c)}</strong> for order <strong>${e(o.storeOrderCode)}</strong>${
          full ? "" : `, ${money(refunded, c)} of ${money(o.storeOrderTotalMinor, c)} so far`
        }.`),
        p(`It goes back to the card or account you paid with. Banks usually take 5–10 business days to show it.`),
        button(orderUrl, "View your order"),
      ].join(""),
      shopperFooter(store)
    ),
  };
}

/* The store's new-order alert, to each member. No shopper link; the dashboard has it all. */
export function newOrderEmail(o: StoreOrder, store: EmailStore, dashboardUrl: string): RenderedEmail {
  const c = o.storeOrderCurrency;
  return {
    subject: `New order ${o.storeOrderCode}: ${money(o.storeOrderTotalMinor, c)} (${o.storeOrderType === "DELIVERY" ? "delivery" : "pickup"})`,
    html: layout(
      `New order ${e(o.storeOrderCode)}`,
      [
        p(`<strong>${e(o.storeOrderCustomer.name)}</strong> paid <strong>${money(o.storeOrderTotalMinor, c)}</strong> for a ${o.storeOrderType === "DELIVERY" ? "delivery" : "pickup"} order at ${e(store.storeName)}.`),
        o.storeOrderStockShortfall
          ? p(`<strong style="color:#b91c1c">Something in this order ran out of stock</strong> before the payment landed. Restock and fulfil it, or refund the customer.`)
          : "",
        linesTable(o, true),
        o.storeOrderNote ? p(`<strong>Note:</strong> ${e(o.storeOrderNote)}`) : "",
        button(dashboardUrl, "Open the order"),
      ].join(""),
      `You get this because you're a member of ${e(store.storeName)} on Ceseelia.`
    ),
  };
}

/* An admin's review decision on Go Live (P.8), to the store's admins. */
export function reviewDecisionEmail(storeName: string, approved: boolean, message: string, storefrontUrl: string): RenderedEmail {
  return {
    subject: approved ? `${storeName} was approved: you can go live` : `${storeName} needs changes before it can go live`,
    html: layout(
      approved ? "Your store was approved" : "Your store needs some changes",
      [
        approved
          ? p(`We reviewed <strong>${e(storeName)}</strong> and it's good to go. Press <strong>Go live</strong> again to choose your plan and open the store.`)
          : p(`We reviewed <strong>${e(storeName)}</strong> and it can't go live yet.`),
        message ? p(`<strong>From the Ceseelia team:</strong><br><span style="white-space:pre-wrap">${e(message)}</span>`) : "",
        !approved ? p(`Make the changes, then press <strong>Go live</strong> again.`) : "",
        button(storefrontUrl, "Open your store"),
      ].join(""),
      "Reply to this email if you have questions."
    ),
  };
}
