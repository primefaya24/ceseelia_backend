import { PassThrough } from "stream";
import { StoreOrder } from "../core/interfaces/store";
import { money, taxNumberLabel } from "./order-email-templates";

// pdfkit has no bundled types here; this is the little of its API the receipt uses.
const PDFDocument = require("pdfkit");

/*
 * The shopper's receipt as a PDF (6.5), attached to the receipt email. Sold by the store (the
 * merchant of record, 5.1), with its tax registration number when it has one; never the
 * platform fee. Built-in Helvetica only covers Western European text (WinAnsi), so other
 * characters are printed as "?" rather than garbled.
 */
export interface ReceiptStore {
  storeName: string;
  storeEmail: string;
  pickupAddress: string;
  taxNumber: string;
}

/* Characters Helvetica (WinAnsi) can print; anything else becomes "?". */
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
export function pdfText(s: string): string {
  return Array.from(s ?? "")
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      if (c === 0x0a) return ch;
      if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.includes(ch)) return ch;
      return "?";
    })
    .join("");
}

const date = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(new Date(ms)) + " UTC";

export function receiptPdf(o: StoreOrder, store: ReceiptStore): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 54, info: { Title: `Receipt ${o.storeOrderCode}`, Author: pdfText(store.storeName) } });
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (c: Buffer) => chunks.push(c));
    out.on("end", () => resolve(Buffer.concat(chunks)));
    out.on("error", reject);
    doc.on("error", reject);
    doc.pipe(out);

    const c = o.storeOrderCurrency;
    const left = 54;
    const right = doc.page.width - 54;
    const width = right - left;
    const grey = "#6b7280";

    // Seller
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#111827").text(pdfText(store.storeName), left, 54, { width: width * 0.6 });
    doc.font("Helvetica").fontSize(9).fillColor(grey);
    if (store.storeEmail) doc.text(pdfText(store.storeEmail), { width: width * 0.6 });
    if (store.pickupAddress) doc.text(pdfText(store.pickupAddress), { width: width * 0.6 });
    if (store.taxNumber) doc.text(`${taxNumberLabel(c)}: ${pdfText(store.taxNumber)}`, { width: width * 0.6 });
    const sellerBottom = doc.y;

    // Receipt facts, top right
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#111827").text("RECEIPT", left, 54, { width, align: "right" });
    doc.font("Helvetica").fontSize(9).fillColor(grey);
    doc.text(`Order ${o.storeOrderCode}`, { width, align: "right" });
    doc.text(`Paid ${date(o.storeOrderPaidAt ?? o.storeOrderCreatedAt)}`, { width, align: "right" });
    doc.text(`Currency ${c}`, { width, align: "right" });

    // Customer and fulfilment
    let y = Math.max(sellerBottom, doc.y) + 24;
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text("Billed to", left, y);
    doc.font("Helvetica").fontSize(10).text(pdfText(o.storeOrderCustomer.name));
    doc.fillColor(grey).text(pdfText(o.storeOrderCustomer.email));
    const custBottom = doc.y;
    doc.font("Helvetica-Bold").fillColor("#111827").text(o.storeOrderType === "DELIVERY" ? "Deliver to" : "Pickup", left + width / 2, y);
    doc.font("Helvetica").fillColor(grey);
    if (o.storeOrderType === "DELIVERY" && o.storeOrderAddress) {
      const a = o.storeOrderAddress;
      doc.text(pdfText(`${a.line1}${a.line2 ? `, ${a.line2}` : ""}\n${a.city}, ${a.region} ${a.postalCode}\n${a.country}`), left + width / 2, doc.y, { width: width / 2 });
    } else {
      doc.text(pdfText(store.pickupAddress || "At the store"), left + width / 2, doc.y, { width: width / 2 });
    }
    y = Math.max(custBottom, doc.y) + 24;

    // Lines
    const amountX = right - 90;
    const qtyX = amountX - 50;
    const rule = (at: number) => doc.moveTo(left, at).lineTo(right, at).lineWidth(0.5).strokeColor("#e5e7eb").stroke();
    doc.font("Helvetica-Bold").fontSize(9).fillColor(grey);
    doc.text("Item", left, y).text("Qty", qtyX, y, { width: 40, align: "right" }).text("Amount", amountX, y, { width: 90, align: "right" });
    y = doc.y + 4;
    rule(y);
    y += 6;
    doc.font("Helvetica").fontSize(10).fillColor("#111827");
    for (const l of o.storeOrderLines) {
      if (y > doc.page.height - 160) {
        doc.addPage();
        y = 54;
      }
      const picks = l.params.map((x) => x.values.join(", ")).filter(Boolean).join(" · ");
      const name = pdfText(l.itemName) + (picks ? `\n${pdfText(picks)}` : "") + (l.discountMinor > 0 ? `\nSaved ${money(l.discountMinor, c)}` : "");
      doc.fillColor("#111827").text(name, left, y, { width: qtyX - left - 10 });
      const bottom = doc.y;
      doc.text(String(l.quantity), qtyX, y, { width: 40, align: "right" });
      doc.text(money(l.totalMinor, c), amountX, y, { width: 90, align: "right" });
      y = Math.max(bottom, doc.y) + 6;
    }
    rule(y);
    y += 8;

    // Totals
    const total = (label: string, value: string, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 10).fillColor("#111827");
      doc.text(label, left + width / 2, y, { width: width / 2 - 100 });
      doc.text(value, amountX, y, { width: 90, align: "right" });
      y = doc.y + 4;
    };
    total("Subtotal", money(o.storeOrderSubtotalMinor - o.storeOrderDiscountMinor, c));
    if (o.storeOrderDiscountMinor > 0) total("You saved", money(o.storeOrderDiscountMinor, c));
    if ((o.storeOrderRewards?.rewardsMinor ?? 0) > 0) total("Rewards", `-${money(o.storeOrderRewards!.rewardsMinor, c)}`);
    if (o.storeOrderDeliveryMinor > 0) total("Delivery", money(o.storeOrderDeliveryMinor, c));
    for (const t of o.storeOrderTaxLines ?? []) {
      if (t.minor > 0) total(`${pdfText(t.label)} ${t.percent}%${o.storeOrderPricesIncludeTax ? " (included)" : ""}`, money(t.minor, c));
    }
    total("Total paid", money(o.storeOrderTotalMinor, c), true);

    if (o.storeOrderNote) {
      y += 12;
      doc.font("Helvetica-Bold").fontSize(9).fillColor(grey).text("Note", left, y);
      doc.font("Helvetica").text(pdfText(o.storeOrderNote), { width });
    }

    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(grey)
      .text(
        `Sold by ${pdfText(store.storeName)}. Payment processed by Stripe; online ordering by Ceseelia.`,
        left,
        doc.page.height - 54 - 10,
        { width, align: "center", lineBreak: false }
      );
    doc.end();
  });
}
