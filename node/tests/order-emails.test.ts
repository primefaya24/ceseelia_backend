import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../layers/aws/ses", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/ses")>()),
  sendEmail: vi.fn(async () => ({ MessageId: "m" })),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/order", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/order")>()),
  getOrderById: vi.fn(),
  addOrderLinkTokenHash: vi.fn(async () => {}),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getStoreOverviewRow: vi.fn(async () => ({ storeName: "Northern Hoop", storeSlug: "northern-hoop" })),
  listStoreMembers: vi.fn(async () => []),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/store", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/store")>()),
  getPublicStoreSettings: vi.fn(),
}));

import { senderName, sendEmail } from "../layers/aws/ses";
import { addOrderLinkTokenHash, getOrderById, hashStatusToken } from "../layers/aws/dynamodb/dynamo-entities/order";
import { listStoreMembers } from "../layers/aws/dynamodb/dynamo-entities/membership";
import { getPublicStoreSettings } from "../layers/aws/dynamodb/dynamo-entities/store";
import { notifyOrderPaid, notifyOrderRefunded, notifyOrderStatus, notifyReviewDecision } from "../layers/notifications/order-emails";
import {
  money,
  newOrderEmail,
  receiptEmail,
  refundEmail,
  statusEmailFor,
} from "../layers/notifications/order-email-templates";
import { StoreOrder, StoreSettings } from "../layers/core/interfaces/store";

const STORE = "01JBZ0000000000000000000AA";
const ORDER_ID = "01JBZ0000000000000000000RD";
const store = { storeName: "Northern <Hoop>", storeEmail: "shop@example.com", pickupAddress: "1 Main St, Calgary" };
const order = (patch: Partial<StoreOrder> = {}): StoreOrder =>
  ({
    storeOrderId: ORDER_ID,
    storeId: STORE,
    storeOrderCode: "K7Q2XM",
    storeOrderStatus: "PAID",
    storeOrderType: "PICKUP",
    storeOrderCurrency: "CAD",
    storeOrderCustomer: { name: "Ann Lee", email: "ann@example.com", phone: "" },
    storeOrderAddress: null,
    storeOrderNote: "<b>no onions</b>",
    storeOrderLines: [
      { itemId: "x", itemName: "Tea & Honey", quantity: 2, params: [{ label: "Size", values: ["L"] }], unitPriceMinor: 1000, discountPercent: 10, subtotalMinor: 2000, discountMinor: 200, totalMinor: 1800 },
    ],
    storeOrderSubtotalMinor: 2000,
    storeOrderDiscountMinor: 200,
    storeOrderDeliveryMinor: 0,
    storeOrderTaxMinor: 90,
    storeOrderTaxLines: [{ code: "GST", label: "GST", percent: 5, minor: 90 }],
    storeOrderPricesIncludeTax: false,
    storeOrderTotalMinor: 1890,
    storeOrderPlatformFeeMinor: 195,
    storeOrderStripe: { accountId: "acct", checkoutSessionId: "cs", paymentIntentId: "pi" },
    storeOrderStatusTokenHash: "h",
    storeOrderCreatedAt: 1,
    storeOrderUpdatedAt: 1,
    ...patch,
  }) as StoreOrder;

describe("order email templates (6.5)", () => {
  it("receipt: escaped text, lines after discount, saving, tax, total; never the platform fee", () => {
    const r = receiptEmail(order(), store, "https://ceseelia.com/s/northern-hoop/order/X#t=abc");
    expect(r.subject).toBe("Your order K7Q2XM from Northern <Hoop>");
    expect(r.html).toContain("Northern &lt;Hoop&gt;");
    expect(r.html).toContain("Tea &amp; Honey");
    expect(r.html).toContain("&lt;b&gt;no onions&lt;/b&gt;");
    expect(r.html).not.toContain("<b>no onions</b>");
    for (const amount of ["$18.00", "$2.00", "$0.90", "$18.90"]) expect(r.html).toContain(amount);
    expect(r.html).not.toContain("$1.95");
    expect(r.html).toContain("1 Main St, Calgary");
    expect(r.html).toContain('href="https://ceseelia.com/s/northern-hoop/order/X#t=abc"');
  });

  it("only pickup READY and delivery SHIPPED email the shopper", () => {
    expect(statusEmailFor({ storeOrderType: "PICKUP" }, "READY")).toBe("READY");
    expect(statusEmailFor({ storeOrderType: "DELIVERY" }, "SHIPPED")).toBe("SHIPPED");
    for (const s of ["PREPARING", "COMPLETED"] as const) {
      expect(statusEmailFor({ storeOrderType: "PICKUP" }, s)).toBeNull();
      expect(statusEmailFor({ storeOrderType: "DELIVERY" }, s)).toBeNull();
    }
    expect(statusEmailFor({ storeOrderType: "DELIVERY" }, "READY")).toBeNull();
  });

  it("refund: part (with the running total) or full; new-order alert flags a stock shortfall", () => {
    const part = refundEmail(order({ storeOrderRefundedMinor: 1000 }), store, 500, false, "u");
    expect(part.subject).toBe("A refund of $5.00 for order K7Q2XM");
    expect(part.html).toContain("$10.00 of $18.90 so far");
    expect(refundEmail(order({ storeOrderStatus: "REFUNDED" }), store, 1890, true, "u").subject).toBe("Your order K7Q2XM was refunded");
    const alert = newOrderEmail(order({ storeOrderStockShortfall: true }), store, "d");
    expect(alert.subject).toBe("New order K7Q2XM: $18.90 (pickup)");
    expect(alert.html).toContain("ran out of stock");
  });

  it("money per currency; sender names are header-safe", () => {
    expect(money(1890, "CAD")).toBe("$18.90");
    expect(money(1890, "USD")).toBe("$18.90");
    expect(senderName('Bad "Name" <x@y>\r\nBcc: z')).toBe("Bad Name x@y Bcc: z");
    expect(senderName("Café Lune via Ceseelia")).toBe(`=?UTF-8?B?${Buffer.from("Café Lune via Ceseelia").toString("base64")}?=`);
    expect(senderName("")).toBe("Ceseelia");
  });
});

describe("sending (6.5)", () => {
  beforeEach(() => {
    vi.mocked(sendEmail).mockClear().mockResolvedValue({ MessageId: "m", $metadata: {} });
    vi.mocked(addOrderLinkTokenHash).mockClear();
    vi.mocked(getOrderById).mockReset().mockResolvedValue(order());
    vi.mocked(getPublicStoreSettings).mockReset().mockResolvedValue({
      storeInfo: { storeName: "Northern Hoop", emailaddress: "shop@example.com" },
      general: { pickupAddress: "1 Main St" },
    } as unknown as StoreSettings);
    vi.mocked(listStoreMembers).mockReset().mockResolvedValue([
      { userId: "U1", firstName: "", lastName: "", email: "Owner@Example.com", role: "ADMIN", createdAt: 1 },
      { userId: "U2", firstName: "", lastName: "", email: "staff@example.com", role: "MERCHANT", createdAt: 2 },
      { userId: "U3", firstName: "", lastName: "", email: "owner@example.com", role: "MERCHANT", createdAt: 3 },
    ]);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("paid: a receipt from the store (Reply-To the store) with a fresh link, and one alert per member email", async () => {
    await notifyOrderPaid(ORDER_ID);
    const calls = vi.mocked(sendEmail).mock.calls;
    const receipt = calls.find((c) => c[2] === "ann@example.com")!;
    expect(receipt[1]).toBe("Northern Hoop via Ceseelia");
    expect(receipt[5]).toBe("shop@example.com");
    const link = /order\/[0-9A-Z]+#t=([A-Za-z0-9_-]+)/.exec(receipt[3])![1];
    expect(vi.mocked(addOrderLinkTokenHash)).toHaveBeenCalledWith(expect.objectContaining({ storeOrderId: ORDER_ID }), hashStatusToken(link));
    expect(receipt[3]).toContain(`/s/northern-hoop/order/${ORDER_ID}#t=`);

    const alerts = calls.filter((c) => c[2] !== "ann@example.com").map((c) => c[2]).sort();
    expect(alerts).toEqual(["owner@example.com", "staff@example.com"]);
    expect(calls.find((c) => c[2] === "staff@example.com")![3]).toContain(`/store/orders/${STORE}?order=${ORDER_ID}`);
  });

  it("status: READY for a pickup sends; PREPARING sends nothing", async () => {
    await notifyOrderStatus(order(), "PREPARING");
    expect(sendEmail).not.toHaveBeenCalled();
    await notifyOrderStatus(order(), "READY");
    expect(vi.mocked(sendEmail).mock.calls[0][0]).toBe("Your order K7Q2XM is ready for pickup");
  });

  it("refund and review decision", async () => {
    await notifyOrderRefunded(order({ storeOrderRefundedMinor: 500 }), 500);
    expect(vi.mocked(sendEmail).mock.calls[0][0]).toBe("A refund of $5.00 for order K7Q2XM");
    vi.mocked(sendEmail).mockClear();
    await notifyOrderRefunded(order(), 0);
    expect(sendEmail).not.toHaveBeenCalled();

    await notifyReviewDecision(STORE, false, "Add real photos");
    const calls = vi.mocked(sendEmail).mock.calls;
    expect(calls.map((c) => c[2])).toEqual(["owner@example.com"]); // ADMIN members only
    expect(calls[0][0]).toBe("Northern Hoop needs changes before it can go live");
    expect(calls[0][3]).toContain("Add real photos");
  });

  it("never throws: a failing lookup or send is logged", async () => {
    vi.mocked(getOrderById).mockRejectedValue(new Error("ddb down"));
    await expect(notifyOrderPaid(ORDER_ID)).resolves.toBeUndefined();
    vi.mocked(addOrderLinkTokenHash).mockRejectedValueOnce(new Error("ddb down"));
    await expect(notifyOrderStatus(order(), "READY")).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});
