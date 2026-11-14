import { initStoreSettings, StoreSettings } from "../layers/core/interfaces/store";

/*
 * Default settings for a store that is open to shoppers. `initStoreSettings()` is a new store,
 * which is a DRAFT since P.2, so public-route tests start from this instead.
 */
export function liveStoreSettings(): StoreSettings {
  return { ...initStoreSettings(), lifecycle: { status: "LIVE", plan: "SPARK" } };
}
