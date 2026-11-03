import { describe, it, expect } from "vitest";
import {
  initStoreSettings,
  isStoreSettingsPure,
  isStoreSettingsValid,
  StoreSettings,
} from "../layers/core/interfaces/store";
import { extractStoreHeaderStripImageUri, extractStorePromoImageUris } from "../layers/core/utils";

const check = (s: unknown) => isStoreSettingsPure(s as StoreSettings) && isStoreSettingsValid(s as StoreSettings);

describe("store settings validation", () => {
  it("accepts default settings", () => {
    expect(check(initStoreSettings())).toBe(true);
  });

  it("tolerates UI-only extra fields", () => {
    const s: any = initStoreSettings();
    s.storeInfo.logoFile = {};
    expect(check(s)).toBe(true);
  });

  it("accepts both redemption method spellings", () => {
    const s = initStoreSettings();
    s.purchaseRewards.redemptionMethod = "REWARDS_REDEMPTION_DISCOUNT";
    expect(check(s)).toBe(true);
    s.purchaseRewards.redemptionMethod = "SOMETHING_ELSE";
    expect(check(s)).toBe(false);
  });

  it.each([
    ["non-object", null],
    ["missing storeInfo", { ...initStoreSettings(), storeInfo: undefined }],
    ["string number", { ...initStoreSettings(), general: { ...initStoreSettings().general, discountPercent: "5" } }],
    ["customize array", { ...initStoreSettings(), customize: [] }],
  ])("rejects %s", (_label, s) => {
    expect(isStoreSettingsPure(s as StoreSettings)).toBe(false);
  });

  it("rejects invalid values", () => {
    const noCurrency = { ...initStoreSettings(), currencies: [] };
    expect(check(noCurrency)).toBe(false);

    const dupCurrency = initStoreSettings();
    dupCurrency.currencies.push({ ...dupCurrency.currencies[0], currencyIsDefault: false });
    expect(check(dupCurrency)).toBe(false);

    const badDiscount = initStoreSettings();
    badDiscount.general.discountPercent = 150;
    expect(check(badDiscount)).toBe(false);

    const badFloat: any = initStoreSettings();
    badFloat.currencies[0].currencyFloat = "MIDDLE";
    expect(check(badFloat)).toBe(false);
  });
});

describe("customize image extraction", () => {
  it("handles empty customize without throwing", () => {
    const s = initStoreSettings();
    expect(extractStoreHeaderStripImageUri(s)).toBe("");
    expect(extractStorePromoImageUris(s)).toEqual([]);
  });

  it("extracts header and non-empty promo uris", () => {
    const s = initStoreSettings();
    s.customize = {
      header: { headerImageStripUri: "store/1/images/header/a.png" },
      promoContent: { promoImages: [{ imageUri: "store/1/images/promo/b.jpg" }, { imageUri: "" }, {}] },
    };
    expect(extractStoreHeaderStripImageUri(s)).toBe("store/1/images/header/a.png");
    expect(extractStorePromoImageUris(s)).toEqual(["store/1/images/promo/b.jpg"]);
  });
});
