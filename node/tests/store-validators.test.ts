import { describe, it, expect } from "vitest";
import { ulid } from "ulid";
import {
  hasStockFor,
  initStoreCategory,
  initStoreSettings,
  isStoreCategoryPure,
  isStoreCategoryValid,
  isStoreItemPure,
  isStoreItemValid,
  isStoreSettingsPure,
  isStoreSettingsValid,
  isUnlimitedStock,
  StoreCategory,
  StoreItem,
  StoreSettings,
} from "../layers/core/interfaces/store";
import { MAX_COUNT, MAX_CUSTOMIZE_JSON, MAX_LENGTH, STOCK_UNLIMITED } from "../constants/input-limits";

const STORE = ulid();
const OTHER_STORE = ulid();
const CAT = ulid();
const ITEM = ulid();
const img = (folder: string, ext = "png") => `${folder}${ulid()}.${ext}`;
const x = (n: number) => "x".repeat(n);

// ---------- settings
const settings = (patch: (s: any) => void = () => {}): StoreSettings => {
  const s: any = initStoreSettings();
  s.customize = {
    colorTheme: { primaryColor: "#ff002b" },
    header: { headerImageStripUri: "", headerImageStripFile: null },
    promoContent: { runnerText: "", promoImages: [{ imageUri: "", imageFile: null }] },
  };
  patch(s);
  return s;
};
const settingsOk = (s: StoreSettings, storeId = STORE) => isStoreSettingsPure(s) && isStoreSettingsValid(s, storeId);

// ---------- category
const category = (patch: Partial<StoreCategory> = {}): StoreCategory => ({ ...initStoreCategory("", "Drinks"), ...patch });
// `id: null` means a create (no ID yet).
const categoryOk = (c: StoreCategory, id: string | null = CAT) =>
  isStoreCategoryPure(c) && isStoreCategoryValid(c, STORE, id ?? undefined);

// ---------- item
const item = (patch: Partial<StoreItem> = {}): StoreItem => ({
  storeItemId: "",
  storeItemCategoryId: CAT,
  storeItemImageUris: [],
  storeItemName: "Tea",
  storeItemStock: 3,
  storeItemPrices: { USD: 1999 },
  storeItemDescription: "",
  storeItemIsActive: true,
  storeItemHashtagIds: [],
  storeItemDiscountPercent: 0,
  storeItemCustomParams: [],
  ...patch,
});
const itemOk = (i: StoreItem, id: string | null = ITEM) => isStoreItemPure(i) && isStoreItemValid(i, STORE, id ?? undefined);
const param = (patch: object = {}) => ({
  storeParamLabel: "Size",
  storeParamType: "SINGLE_SELECT",
  storeParamIsMandatory: true,
  storeParamOptions: ["S", "M"],
  ...patch,
});

describe("defaults pass", () => {
  it("settings, category and item", () => {
    expect(settingsOk(settings())).toBe(true);
    expect(settingsOk(initStoreSettings())).toBe(true);
    expect(categoryOk(category())).toBe(true);
    expect(itemOk(item())).toBe(true);
  });
});

describe("a. max lengths", () => {
  it.each<[string, (s: any) => void]>([
    ["store name", (s) => (s.storeInfo.storeName = x(MAX_LENGTH.storeName + 1))],
    ["slogan", (s) => (s.storeInfo.slogan = x(MAX_LENGTH.storeSlogan + 1))],
    ["rewards label", (s) => (s.purchaseRewards.rewardsLabel = x(MAX_LENGTH.rewardsLabel + 1))],
    ["pickup address", (s) => (s.general.pickupAddress = x(MAX_LENGTH.pickupAddress + 1))],
    ["runner text", (s) => (s.customize.promoContent.runnerText = x(MAX_LENGTH.promoRunnerText + 1))],
    ["link", (s) => (s.socialMediaLinks.etsy = "https://etsy.com/" + x(MAX_LENGTH.url))],
  ])("settings rejects a too-long %s", (_n, patch) => {
    expect(settingsOk(settings(patch))).toBe(false);
  });

  it("accepts values exactly at the limit", () => {
    expect(settingsOk(settings((s) => (s.storeInfo.storeName = x(MAX_LENGTH.storeName))))).toBe(true);
    expect(itemOk(item({ storeItemDescription: x(MAX_LENGTH.itemDescription) }))).toBe(true);
  });

  it("category name, hashtags and item fields", () => {
    expect(categoryOk(category({ storeCategoryName: x(MAX_LENGTH.categoryName + 1) }))).toBe(false);
    expect(categoryOk(category({ storeCategoriyHashtags: [{ id: "h1", value: x(MAX_LENGTH.hashtag + 1) }] }))).toBe(false);
    expect(itemOk(item({ storeItemName: x(MAX_LENGTH.itemName + 1) }))).toBe(false);
    expect(itemOk(item({ storeItemDescription: x(MAX_LENGTH.itemDescription + 1) }))).toBe(false);
    expect(itemOk(item({ storeItemCustomParams: [param({ storeParamLabel: x(MAX_LENGTH.paramLabel + 1) })] as any }))).toBe(false);
    expect(itemOk(item({ storeItemCustomParams: [param({ storeParamOptions: [x(MAX_LENGTH.paramOption + 1)] })] as any }))).toBe(false);
  });
});

describe("b. numbers", () => {
  it.each([
    ["negative price", { storeItemPrices: { USD: -1 } }],
    ["price over 1,000,000.00", { storeItemPrices: { USD: 100_000_001 } }],
    ["fractional cents", { storeItemPrices: { USD: 19.99 } }],
    ["no prices", { storeItemPrices: {} }],
    ["unknown currency", { storeItemPrices: { EUR: 100 } }],
    ["a non-number price", { storeItemPrices: { USD: "100" } }],
    ["prices not an object", { storeItemPrices: 100 }],
    ["the old single price", { storeItemPrices: undefined, storeItemPrice: 19.99 }],
    ["fractional stock", { storeItemStock: 1.5 }],
    ["stock below -1", { storeItemStock: -2 }],
    ["discount over 100", { storeItemDiscountPercent: 101 }],
    ["negative discount", { storeItemDiscountPercent: -1 }],
  ])("item rejects %s", (_n, patch) => {
    expect(itemOk(item(patch as Partial<StoreItem>))).toBe(false);
  });

  it("item accepts unlimited stock (-1), free items and a price per currency (2.5)", () => {
    expect(itemOk(item({ storeItemStock: -1 }))).toBe(true);
    expect(itemOk(item({ storeItemStock: 0, storeItemPrices: { USD: 0 } }))).toBe(true);
    expect(itemOk(item({ storeItemPrices: { USD: 6500, CAD: 8900, AUD: 9900 } }))).toBe(true);
    expect(itemOk(item({ storeItemPrices: { CAD: 100_000_000 } }))).toBe(true);
  });

  it("category discount and priority", () => {
    expect(categoryOk(category({ storeCategoryDiscountPercent: 101 }))).toBe(false);
    expect(categoryOk(category({ storeCategoriyPriority: "PRIORITY_URGENT" as any }))).toBe(false);
    expect(categoryOk(category({ storeCategoriyPriority: "PRIORITY_HIGHT" }))).toBe(true);
  });

  it("settings ranges", () => {
    expect(settingsOk(settings((s) => (s.general.discountPercent = 101)))).toBe(false);
    expect(settingsOk(settings((s) => (s.purchaseRewards.redemptionPointAmount = 10.5)))).toBe(false);
    expect(settingsOk(settings((s) => (s.purchaseRewards.pointsPerDollarSpent = 1_000_001)))).toBe(false);
    // A percentage reward can't exceed 100; a money reward can.
    const reward = (method: string, value: number) =>
      settings((s) => Object.assign(s.purchaseRewards, { redemptionMethod: method, redemptionPointAmountValue: value }));
    expect(settingsOk(reward("REWARDS_REDEMPTION_DISCOUNT", 150))).toBe(false);
    expect(settingsOk(reward("REWARDS_REDEMPTION_DOLLAR", 150))).toBe(true);
  });
});

describe("c. list sizes", () => {
  const folder = `store/${STORE}/item/${ITEM}/images/`;
  it("item lists", () => {
    const images = (n: number) => Array.from({ length: n }, () => img(folder));
    expect(itemOk(item({ storeItemImageUris: images(MAX_COUNT.itemImages) }))).toBe(true);
    expect(itemOk(item({ storeItemImageUris: images(MAX_COUNT.itemImages + 1) }))).toBe(false);
    expect(itemOk(item({ storeItemHashtagIds: Array(MAX_COUNT.itemHashtags + 1).fill("h") }))).toBe(false);
    expect(itemOk(item({ storeItemCustomParams: Array(MAX_COUNT.itemParams + 1).fill(param()) }))).toBe(false);
    expect(itemOk(item({ storeItemCustomParams: [param({ storeParamOptions: Array(MAX_COUNT.paramOptions + 1).fill("o") })] as any }))).toBe(false);
  });

  it("category hashtags, promo images and currencies", () => {
    const tags = Array.from({ length: MAX_COUNT.categoryHashtags + 1 }, (_, i) => ({ id: `h${i}`, value: "tag" }));
    expect(categoryOk(category({ storeCategoriyHashtags: tags }))).toBe(false);
    expect(
      settingsOk(settings((s) => (s.customize.promoContent.promoImages = Array(MAX_COUNT.promoImages + 1).fill({ imageUri: "" }))))
    ).toBe(false);
    const cur = (code: string, def = false) => ({ currencyCode: code, currencySign: "$", currencyFloat: "LEFT", currencyIsDefault: def });
    expect(settingsOk(settings((s) => (s.currencies = [cur("USD", true), cur("CAD"), cur("AUD"), cur("USD")])))).toBe(false);
  });
});

describe("d. image keys belong to this store", () => {
  it("settings logo, header and promo images", () => {
    expect(settingsOk(settings((s) => (s.storeInfo.logoUri = img(`store/${STORE}/images/logo/`))))).toBe(true);
    expect(settingsOk(settings((s) => (s.storeInfo.logoUri = img(`store/${OTHER_STORE}/images/logo/`))))).toBe(false);
    expect(settingsOk(settings((s) => (s.storeInfo.logoUri = img(`store/${STORE}/images/promo/`))))).toBe(false);
    expect(settingsOk(settings((s) => (s.storeInfo.logoUri = `store/${STORE}/images/logo/../../x.png`)))).toBe(false);
    expect(settingsOk(settings((s) => (s.customize.header.headerImageStripUri = img(`store/${STORE}/images/header/`, "jpg"))))).toBe(true);
    expect(settingsOk(settings((s) => (s.customize.header.headerImageStripUri = img(`store/${OTHER_STORE}/images/header/`))))).toBe(false);
    expect(settingsOk(settings((s) => (s.customize.promoContent.promoImages[0].imageUri = img(`store/${STORE}/images/promo/`, "jpeg"))))).toBe(true);
    expect(settingsOk(settings((s) => (s.customize.promoContent.promoImages[0].imageUri = "https://evil.example/x.png")))).toBe(false);
  });

  it("category banner and item images", () => {
    expect(categoryOk(category({ storeCategoryBannerUri: img(`store/${STORE}/category/${CAT}/images/`) }))).toBe(true);
    expect(categoryOk(category({ storeCategoryBannerUri: img(`store/${STORE}/category/${ulid()}/images/`) }))).toBe(false);
    expect(itemOk(item({ storeItemImageUris: [img(`store/${STORE}/item/${ITEM}/images/`)] }))).toBe(true);
    expect(itemOk(item({ storeItemImageUris: [img(`store/${OTHER_STORE}/item/${ITEM}/images/`)] }))).toBe(false);
    expect(itemOk(item({ storeItemImageUris: [""] }))).toBe(false);
  });

  it("a new category or item can't reference images yet", () => {
    expect(categoryOk(category({ storeCategoryBannerUri: img(`store/${STORE}/category/${CAT}/images/`) }), null)).toBe(false);
    expect(categoryOk(category(), null)).toBe(true);
    expect(itemOk(item({ storeItemImageUris: [img(`store/${STORE}/item/${ITEM}/images/`)] }), null)).toBe(false);
    expect(itemOk(item(), null)).toBe(true);
  });
});

describe("e. formats", () => {
  it.each<[string, (s: any) => void, boolean]>([
    ["https link", (s) => (s.socialMediaLinks.facebook = "https://facebook.com/shop"), true],
    ["link without scheme", (s) => (s.socialMediaLinks.facebook = "facebook.com/shop"), false],
    ["javascript: link", (s) => (s.socialMediaLinks.facebook = "javascript:alert(1)"), false],
    ["email", (s) => (s.storeInfo.emailaddress = "shop@example.com"), true],
    ["bad email", (s) => (s.storeInfo.emailaddress = "shop@"), false],
    ["phone", (s) => (s.storeInfo.phoneNumber = "+1 (555) 123-4567"), true],
    ["bad phone", (s) => (s.storeInfo.phoneNumber = "call me"), false],
    ["whatsapp", (s) => (s.socialMediaLinks.whatsapp = "15551234567"), true],
    ["whatsapp link instead of number", (s) => (s.socialMediaLinks.whatsapp = "https://wa.me/1555"), false],
  ])("%s", (_n, patch, ok) => {
    expect(settingsOk(settings(patch))).toBe(ok);
  });

  it("item category must be a real ID", () => {
    expect(itemOk(item({ storeItemCategoryId: "CAT1" }))).toBe(false);
  });
});

describe("f. currencies", () => {
  const cur = (code: string, def: boolean) => ({ currencyCode: code, currencySign: "$", currencyFloat: "LEFT", currencyIsDefault: def });
  it("exactly one default", () => {
    expect(settingsOk(settings((s) => (s.currencies = [cur("USD", true), cur("CAD", false)])))).toBe(true);
    expect(settingsOk(settings((s) => (s.currencies = [cur("USD", true), cur("CAD", true)])))).toBe(false);
    expect(settingsOk(settings((s) => (s.currencies = [cur("USD", false)])))).toBe(false);
  });
  it("codes from the allow-list", () => {
    expect(settingsOk(settings((s) => (s.currencies = [cur("XYZ", true)])))).toBe(false);
    expect(settingsOk(settings((s) => (s.currencies = [cur("usd", true)])))).toBe(false);
  });
});

describe("g. customize", () => {
  it("checks colors and caps the size", () => {
    expect(settingsOk(settings((s) => (s.customize.colorTheme.primaryColor = "red")))).toBe(false);
    expect(settingsOk(settings((s) => (s.customize.colorTheme.primaryColor = "#abc")))).toBe(true);
    expect(settingsOk(settings((s) => (s.customize.extra = x(MAX_CUSTOMIZE_JSON))))).toBe(false);
  });
  it("tolerates an empty customize (older saves)", () => {
    expect(settingsOk(settings((s) => (s.customize = {})))).toBe(true);
  });
});

describe("h. parameter options", () => {
  it("must be non-empty strings", () => {
    expect(itemOk(item({ storeItemCustomParams: [param({ storeParamOptions: [""] })] as any }))).toBe(false);
    expect(itemOk(item({ storeItemCustomParams: [param({ storeParamOptions: [1] })] as any }))).toBe(false);
    expect(itemOk(item({ storeItemCustomParams: [param()] as any }))).toBe(true);
  });
});

describe("non-object payloads are rejected, not crashed on", () => {
  it.each([null, 1, "x", []])("%j", (v) => {
    expect(isStoreItemPure(v as any)).toBe(false);
    expect(isStoreCategoryPure(v as any)).toBe(false);
    expect(isStoreSettingsPure(v as any)).toBe(false);
  });
});

describe("stock rule (2.6)", () => {
  it("-1 is unlimited; 0 and up are tracked", () => {
    expect(STOCK_UNLIMITED).toBe(-1);
    expect(isUnlimitedStock(-1)).toBe(true);
    expect(isUnlimitedStock(0)).toBe(false);
  });

  it("unlimited stock always has enough", () => {
    expect(hasStockFor(-1)).toBe(true);
    expect(hasStockFor(-1, 1_000_000)).toBe(true);
  });

  it("tracked stock needs at least the quantity; 0 is sold out", () => {
    expect(hasStockFor(3, 3)).toBe(true);
    expect(hasStockFor(3, 4)).toBe(false);
    expect(hasStockFor(0)).toBe(false);
  });

  it("refuses a quantity that isn't a whole number >= 1, and broken stock values", () => {
    expect(hasStockFor(5, 0)).toBe(false);
    expect(hasStockFor(5, 1.5)).toBe(false);
    expect(hasStockFor(-2, 1)).toBe(false);
    expect(hasStockFor(2.5, 1)).toBe(false);
  });
});
