import { fulfilmentSettings, StoreInventoryData } from "../interfaces/store";
import { toPublicInventory } from "../../aws/dynamodb/dynamo-entities/store";

/*
 * The Go Live checklist (progress.md P.4a). Pure: the caller supplies what needs a network call
 * (Stripe's live `charges_enabled`). The same function backs the checklist the webapp shows and
 * the server's re-check in POST /store/go-live, so they can't disagree.
 */
export const GO_LIVE_STEPS = ["STORE_NAME", "ITEMS", "FULFILMENT", "PAYMENTS"] as const;
export type GoLiveStepId = (typeof GO_LIVE_STEPS)[number];

export interface GoLiveStep {
  id: GoLiveStepId;
  ok: boolean;
  /** What's missing, in words the merchant can act on; empty when ok. */
  message: string;
}

export function goLiveChecklist(data: StoreInventoryData, opts: { chargesEnabled: boolean }): GoLiveStep[] {
  const name = (data.settings.storeInfo?.storeName ?? "").trim();
  const shown = toPublicInventory(data).items.length;
  const f = fulfilmentSettings(data.settings.general);
  const pickupReady = f.pickupEnabled && (data.settings.general?.pickupAddress ?? "").trim().length > 0;
  const step = (id: GoLiveStepId, ok: boolean, message: string): GoLiveStep => ({ id, ok, message: ok ? "" : message });
  return [
    step("STORE_NAME", name.length > 0, "Add your store's name in Store info."),
    step(
      "ITEMS",
      shown > 0,
      "Add at least one active item, in an active category, with a price in one of your currencies."
    ),
    step("FULFILMENT", f.taxReviewed && (pickupReady || f.deliveryEnabled), fulfilmentHint(f.taxReviewed, pickupReady || f.deliveryEnabled, f.pickupEnabled)),
    step("PAYMENTS", opts.chargesEnabled, "Connect Stripe and finish its setup so you can take payments."),
  ];
}

/*
 * T.2: the "Tax and delivery" step's hint. It's done once the merchant has saved the Tax and
 * delivery card (taxReviewed) and pickup (with an address) or delivery is on.
 */
function fulfilmentHint(taxReviewed: boolean, fulfilmentReady: boolean, pickupEnabled: boolean): string {
  const fulfil = pickupEnabled ? "add your pickup address or turn on delivery" : "turn on pickup or delivery";
  if (!taxReviewed && !fulfilmentReady) return `Check your tax setting, and ${fulfil}.`;
  if (!taxReviewed) return "Check your tax setting and save it.";
  return fulfil.charAt(0).toUpperCase() + fulfil.slice(1) + ".";
}

/** A subscription is billed in the currency of the store's Stripe account country (A1). */
export function billingCurrencyFor(country: string | null | undefined): "CAD" | "USD" | "AUD" | null {
  switch ((country ?? "").toUpperCase()) {
    case "CA":
      return "CAD";
    case "US":
      return "USD";
    case "AU":
      return "AUD";
    default:
      return null;
  }
}
