import { describe, it, expect } from "vitest";
import { orderRefundState, sameRefundState, LiveRefund } from "../layers/core/refunds";
import { StoreOrder } from "../layers/core/interfaces/store";

const order = (patch: Partial<StoreOrder> = {}): StoreOrder =>
  ({ storeOrderStatus: "PAID", storeOrderTotalMinor: 2000, storeOrderUpdatedAt: 1, ...patch }) as StoreOrder;
const r = (id: string, amount: number, status = "succeeded", created = 100): LiveRefund => ({ id, amount, status, created });

describe("orderRefundState (6.4b)", () => {
  it("counts succeeded, pending and requires_action; not failed or canceled", () => {
    const s = orderRefundState(order(), [r("a", 300), r("b", 400, "pending"), r("c", 100, "requires_action"), r("d", 500, "failed"), r("e", 50, "canceled")]);
    expect(s.storeOrderRefundedMinor).toBe(800);
    expect(s.storeOrderStatus).toBe("PAID");
    expect(s.storeOrderFailedRefunds.map((f) => f.refundId)).toEqual(["d", "e"]);
  });

  it("all of it → REFUNDED from any paid step; never from unpaid or cancelled", () => {
    expect(orderRefundState(order({ storeOrderStatus: "COMPLETED" }), [r("a", 2000)]).storeOrderStatus).toBe("REFUNDED");
    expect(orderRefundState(order({ storeOrderStatus: "CANCELLED" }), [r("a", 2000)]).storeOrderStatus).toBe("CANCELLED");
  });

  it("a failed refund takes REFUNDED back to the last step, else PAID", () => {
    const failed = [r("a", 2000, "failed")];
    const hist = [{ status: "PREPARING" as const, at: 1, by: "U" }, { status: "READY" as const, at: 2, by: "U" }];
    expect(orderRefundState(order({ storeOrderStatus: "REFUNDED", storeOrderStatusHistory: hist }), failed).storeOrderStatus).toBe("READY");
    expect(orderRefundState(order({ storeOrderStatus: "REFUNDED" }), failed).storeOrderStatus).toBe("PAID");
  });

  it("updates our entries' statuses; leaves dashboard refunds out of the list; caps at the total", () => {
    const o = order({ storeOrderRefunds: [{ refundId: "a", amountMinor: 300, status: "pending", reason: null, at: 1, by: "U" }] });
    const s = orderRefundState(o, [r("a", 300), r("dash", 5000)]);
    expect(s.storeOrderRefunds).toEqual([{ refundId: "a", amountMinor: 300, status: "succeeded", reason: null, at: 1, by: "U" }]);
    expect(s.storeOrderRefundedMinor).toBe(2000);
  });

  it("sameRefundState: nothing to write when Stripe agrees", () => {
    const o = order({ storeOrderRefundedMinor: 300, storeOrderRefunds: [], storeOrderFailedRefunds: [] });
    expect(sameRefundState(o, orderRefundState(o, [r("x", 300)]))).toBe(true);
    expect(sameRefundState(o, orderRefundState(o, [r("x", 300, "failed")]))).toBe(false);
    expect(sameRefundState(order(), orderRefundState(order(), []))).toBe(true);
  });
});
