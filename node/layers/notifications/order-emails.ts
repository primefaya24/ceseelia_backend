import { WEBAPP_URL } from "../../config";
import { StoreOrder, StoreOrderStatus } from "../core/interfaces/store";
import { sendEmail } from "../aws/ses";
import { addOrderLinkTokenHash, getOrderById, newStatusToken } from "../aws/dynamodb/dynamo-entities/order";
import { getStoreOverviewRow, listStoreMembers } from "../aws/dynamodb/dynamo-entities/membership";
import { getPublicStoreSettings } from "../aws/dynamodb/dynamo-entities/store";
import {
  EmailStore,
  newOrderEmail,
  receiptEmail,
  RenderedEmail,
  refundEmail,
  reviewDecisionEmail,
  statusEmail,
  statusEmailFor,
} from "./order-email-templates";

/*
 * Sending the order emails (progress.md 6.5) through SES. Every function here is best effort: it
 * never throws (an email must never fail a webhook, a status step or a refund) and logs what it
 * couldn't send. Callers that answer an HTTP request don't wait for it (`void notify…`).
 *
 *   paid (webhook / sweeper, first time only) → shopper receipt + new-order alert to every member
 *   status step to READY (pickup) / SHIPPED (delivery) → shopper
 *   refund recorded (ours or the dashboard's, `syncOrderRefunds`) → shopper
 *   review decision (P.8) → the store's ADMIN members
 *
 * Shopper emails are "<Store> via Ceseelia" from our address, with the store's email as Reply-To,
 * and carry an order link with its own token (only its hash is kept) in the URL fragment, which
 * never reaches a server or its logs.
 */

const base = () => WEBAPP_URL.replace(/\/$/, "");

async function storeFor(storeId: string): Promise<EmailStore & { storeSlug: string }> {
  const overview = await getStoreOverviewRow(storeId).catch(() => null);
  let storeEmail = "";
  let pickupAddress = "";
  let storeName = String(overview?.storeName ?? "");
  try {
    const settings = await getPublicStoreSettings(storeId);
    storeEmail = settings.storeInfo?.emailaddress?.trim() ?? "";
    pickupAddress = settings.general?.pickupAddress?.trim() ?? "";
    storeName = settings.storeInfo?.storeName?.trim() || storeName;
  } catch {
    // A suspended or deleted store: the name from the overview is enough.
  }
  return { storeName: storeName || "Your store", storeEmail, pickupAddress, storeSlug: String(overview?.storeSlug ?? "") };
}

/* A fresh link to the shopper's order page; its token's hash is saved on the order first. */
async function orderLink(order: StoreOrder, storeSlug: string): Promise<string> {
  const { token, hash } = newStatusToken();
  await addOrderLinkTokenHash(order, hash);
  return `${base()}/s/${encodeURIComponent(storeSlug)}/order/${order.storeOrderId}#t=${token}`;
}

async function send(to: string, fromName: string, email: RenderedEmail, replyTo?: string): Promise<boolean> {
  if (!to) return false;
  const sent = await sendEmail(email.subject, fromName, to, email.html, false, replyTo || undefined);
  return !!sent;
}

const shopperFrom = (store: EmailStore) => `${store.storeName} via Ceseelia`;

function logged(what: string, orderId: string) {
  return (e: unknown) => console.error(`[order emails] ${what} for order ${orderId} failed`, (e as Error)?.message ?? e);
}

/* After an order is first marked paid: the shopper's receipt and the store's alert. */
export async function notifyOrderPaid(orderId: string): Promise<void> {
  try {
    const order = await getOrderById(orderId);
    if (!order) return;
    const store = await storeFor(order.storeId);
    const link = await orderLink(order, store.storeSlug);
    const receipt = send(order.storeOrderCustomer.email, shopperFrom(store), receiptEmail(order, store, link), store.storeEmail);

    const members = await listStoreMembers(order.storeId);
    const alert = newOrderEmail(order, store, `${base()}/store/orders/${order.storeId}?order=${order.storeOrderId}`);
    const alerts = [...new Set(members.map((m) => m.email.trim().toLowerCase()).filter(Boolean))].map((to) =>
      send(to, "Ceseelia", alert)
    );
    const results = await Promise.all([receipt, ...alerts]);
    if (!results[0]) console.error(`[order emails] receipt for order ${orderId} wasn't sent`);
  } catch (e) {
    logged("paid emails", orderId)(e);
  }
}

/* After the merchant moves an order on: only the steps a shopper cares about. */
export async function notifyOrderStatus(order: StoreOrder, to: StoreOrderStatus): Promise<void> {
  const kind = statusEmailFor(order, to);
  if (!kind) return;
  try {
    const store = await storeFor(order.storeId);
    const link = await orderLink(order, store.storeSlug);
    await send(order.storeOrderCustomer.email, shopperFrom(store), statusEmail(order, store, kind, link), store.storeEmail);
  } catch (e) {
    logged(`${kind} email`, order.storeOrderId)(e);
  }
}

/* After a refund is recorded (`order` is the order with its new refunded total). */
export async function notifyOrderRefunded(order: StoreOrder, amountMinor: number): Promise<void> {
  if (amountMinor <= 0) return;
  try {
    const store = await storeFor(order.storeId);
    const link = await orderLink(order, store.storeSlug);
    const full = order.storeOrderStatus === "REFUNDED";
    await send(order.storeOrderCustomer.email, shopperFrom(store), refundEmail(order, store, amountMinor, full, link), store.storeEmail);
  } catch (e) {
    logged("refund email", order.storeOrderId)(e);
  }
}

/* An admin approved or rejected a store's Go Live (P.8): to its ADMIN members. */
export async function notifyReviewDecision(storeId: string, approved: boolean, message: string): Promise<void> {
  try {
    const store = await storeFor(storeId);
    const members = await listStoreMembers(storeId);
    const email = reviewDecisionEmail(store.storeName, approved, message, `${base()}/store/storefront/${storeId}`);
    const admins = [...new Set(members.filter((m) => m.role === "ADMIN").map((m) => m.email.trim().toLowerCase()).filter(Boolean))];
    await Promise.all(admins.map((to) => send(to, "Ceseelia", email)));
  } catch (e) {
    console.error(`[order emails] review decision email for store ${storeId} failed`, (e as Error)?.message ?? e);
  }
}
