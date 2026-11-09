/*
 * Merchant Join Requests
 */

import {
  appConstants,
  PRIORITY,
  PRIORITY_DEFAULT,
  PRIORITY_HIGHT,
  PRIORITY_MEDIUM,
  STORE_CURRENCY_FLOAT,
  STORE_PARAM_TYPE,
} from "../../../../constants";
import {
  CURRENCY_CODES,
  MAX_COUNT,
  MAX_CUSTOMIZE_JSON,
  MAX_LENGTH,
  NUMBER_RANGE,
  STOCK_UNLIMITED,
} from "../../../../constants/input-limits";
import {
  isEmailOrEmpty,
  isHexColor,
  isImageKeyOrEmpty,
  isInRange,
  isMaxLength,
  isPhoneOrEmpty,
  isUrlOrEmpty,
  storeImageFolder,
} from "../../utils/validation";
import { isUlid } from "../../utils";

// JOIN_REQUEST, REQUEST_ID
export interface Merchant {
  joinRequesttName: string;
  joinRequesttEmail: string;
  joinRequesttPhoneNumber: string;
  joinRequesttBusinessName: string | undefined;
  joinRequesttMessage: string | undefined;
}

export function initMerchant(): Merchant {
  return {
    joinRequesttName: "",
    joinRequesttEmail: "",
    joinRequesttPhoneNumber: "",
    joinRequesttBusinessName: "",
    joinRequesttMessage: "",
  };
}

/*
 * Ceseelia Stores
 */
// APP_STORE, STORE#store_id
export interface StoreOverview {
  storeId: string;
  storeName: string;
  storeSlug: string;
  storeOrderCount: number;
  storeCompletedOrdersCount: number;
  storeCancelledOrdersCount: number;
  storeOrderLastCompletedTimestamp: number;
  storeOrderLastCompletedDateStr: string;
}

export function initStore(
  storeId: string,
  storeName: string,
  storeSlug: string
): StoreOverview {
  return {
    storeId: storeId,
    storeName: storeName,
    storeSlug: storeSlug,
    storeOrderCount: 0,
    storeCompletedOrdersCount: 0,
    storeCancelledOrdersCount: 0,
    storeOrderLastCompletedTimestamp: 0,
    storeOrderLastCompletedDateStr: appConstants.NA,
  };
}

// STORE#store_id, SETTINGS
export interface StoreSettings {
  // Merchant
  templateId: string;
  themeId: string;

  storeInfo: {
    storeName: string;
    slogan: string;
    logoUri: string;
    phoneNumber: string;
    emailaddress: string;
  };

  purchaseRewards: {
    redemptionMethod: string;
    rewardsLabel: string; // i.e - PH Points

    redemptionPointAmount: number; // 350
    redemptionPointAmountValue: number; // $10, 10%

    pointsPerDollarSpent: number; // i.e - 5
    isAvailable: boolean;
  };

  socialMediaLinks: {
    websiteLink: string;
    facebook: string;
    instagram: string;
    tiktok: string;
    twitter: string;
    youtube: string;
    pinterest: string;
    etsy: string;
    whatsapp: string;
  };

  currencies: StoreCurrency[];

  general: {
    pickupAddress: string;
    discountPercent: number;
    isOnline: boolean;
  };

  // Admin
  admin: {
    salesCommission: number; // $1.25 default
    isStoreLive: boolean; // False
  };

  customize: any;
}

export function initStoreSettings(): StoreSettings {
  return {
    // Merchant
    templateId: appConstants.STORE_TEMPLATE_DEFAULT,
    themeId: appConstants.STORE_THEME_DEFAULT,
    customize: {},
    storeInfo: {
      storeName: "",
      slogan: "",
      logoUri: "",
      phoneNumber: "",
      emailaddress: "",
    },
    purchaseRewards: {
      isAvailable: false,
      rewardsLabel: "",
      pointsPerDollarSpent: 0,
      redemptionMethod:
        appConstants.STORE_REWARDS_REDEMPTION_METHOD_POINTS_TO_MONEY,
      redemptionPointAmount: 0,
      redemptionPointAmountValue: 0,
    },
    socialMediaLinks: {
      websiteLink: "",
      facebook: "",
      instagram: "",
      tiktok: "",
      twitter: "",
      youtube: "",
      pinterest: "",
      etsy: "",
      whatsapp: "",
    },
    currencies: [initStoreCurrency()],
    general: {
      pickupAddress: "",
      discountPercent: 0,
      isOnline: false,
    },

    // Admin
    admin: {
      salesCommission: appConstants.STORE_DEFAULT_SALES_COMMISSION,
      isStoreLive: true,
    },
  };
}

const isObject = (v: unknown): v is Record<string, any> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const allStrings = (obj: Record<string, any>, keys: string[]): boolean =>
  keys.every((k) => typeof obj[k] === "string");

const STORE_INFO_STRING_KEYS = ["storeName", "slogan", "logoUri", "phoneNumber", "emailaddress"];
const SOCIAL_MEDIA_KEYS = [
  "websiteLink", "facebook", "instagram", "tiktok", "twitter",
  "youtube", "pinterest", "etsy", "whatsapp",
];

/*
 * Type checks for the merchant-editable settings. Extra (UI-only) fields are tolerated.
 * `admin` is intentionally not checked: it is not persisted by update-settings.
 */
export function isStoreSettingsPure(storeSettings: StoreSettings): boolean {
  const s: any = storeSettings;
  if (!isObject(s)) return false;
  if (typeof s.templateId !== "string" || typeof s.themeId !== "string") return false;

  if (!isObject(s.storeInfo) || !allStrings(s.storeInfo, STORE_INFO_STRING_KEYS)) return false;

  const r = s.purchaseRewards;
  if (
    !isObject(r) ||
    typeof r.redemptionMethod !== "string" ||
    typeof r.rewardsLabel !== "string" ||
    !isFiniteNumber(r.redemptionPointAmount) ||
    !isFiniteNumber(r.redemptionPointAmountValue) ||
    !isFiniteNumber(r.pointsPerDollarSpent) ||
    typeof r.isAvailable !== "boolean"
  ) return false;

  if (!isObject(s.socialMediaLinks) || !allStrings(s.socialMediaLinks, SOCIAL_MEDIA_KEYS)) return false;

  if (!Array.isArray(s.currencies) || !s.currencies.every(isStoreCurrencyPure)) return false;

  const g = s.general;
  if (
    !isObject(g) ||
    typeof g.pickupAddress !== "string" ||
    !isFiniteNumber(g.discountPercent) ||
    typeof g.isOnline !== "boolean"
  ) return false;

  if (s.customize !== undefined && !isObject(s.customize)) return false;

  return true;
}

const SOCIAL_URL_KEYS = [
  "websiteLink", "facebook", "instagram", "tiktok", "twitter", "youtube", "pinterest", "etsy",
] as const;

/*
 * Value checks (call only after isStoreSettingsPure). `storeId` must already be a checked ULID:
 * image keys must sit in this store's own folders.
 */
export function isStoreSettingsValid(storeSettings: StoreSettings, storeId: string): boolean {
  const s = storeSettings;
  if (s.templateId.length === 0 || s.themeId.length === 0) return false;
  if (!isMaxLength(s.templateId, MAX_LENGTH.templateId) || !isMaxLength(s.themeId, MAX_LENGTH.templateId)) {
    return false;
  }

  // Store info
  const info = s.storeInfo;
  if (
    !isMaxLength(info.storeName, MAX_LENGTH.storeName) ||
    !isMaxLength(info.slogan, MAX_LENGTH.storeSlogan) ||
    !isMaxLength(info.emailaddress, MAX_LENGTH.email) ||
    !isEmailOrEmpty(info.emailaddress) ||
    !isMaxLength(info.phoneNumber, MAX_LENGTH.phone) ||
    !isPhoneOrEmpty(info.phoneNumber) ||
    !isImageKeyOrEmpty(info.logoUri, storeImageFolder.logo(storeId))
  ) return false;

  // Rewards
  const r = s.purchaseRewards;
  // TODO(Stage 7): unify — the webapp saves REWARDS_REDEMPTION_*, the backend default is POINTS_TO_*
  const redemptionMethods = [
    appConstants.STORE_REWARDS_REDEMPTION_METHOD_POINTS_TO_MONEY,
    appConstants.STORE_REWARDS_REDEMPTION_METHOD_POINTS_TO_DISCOUNT,
    "REWARDS_REDEMPTION_DOLLAR",
    "REWARDS_REDEMPTION_DISCOUNT",
  ];
  if (!redemptionMethods.includes(r.redemptionMethod)) return false;
  const isPercentReward =
    r.redemptionMethod === appConstants.STORE_REWARDS_REDEMPTION_METHOD_POINTS_TO_DISCOUNT ||
    r.redemptionMethod === "REWARDS_REDEMPTION_DISCOUNT";
  if (
    !isMaxLength(r.rewardsLabel, MAX_LENGTH.rewardsLabel) ||
    !isInRange(r.redemptionPointAmount, NUMBER_RANGE.points) ||
    !Number.isInteger(r.redemptionPointAmount) ||
    !isInRange(r.redemptionPointAmountValue, isPercentReward ? NUMBER_RANGE.percent : NUMBER_RANGE.price) ||
    !isInRange(r.pointsPerDollarSpent, NUMBER_RANGE.points)
  ) return false;

  // Social links
  const links = s.socialMediaLinks;
  if (!SOCIAL_URL_KEYS.every((k) => isMaxLength(links[k], MAX_LENGTH.url) && isUrlOrEmpty(links[k]))) {
    return false;
  }
  if (!isMaxLength(links.whatsapp, MAX_LENGTH.phone) || !isPhoneOrEmpty(links.whatsapp)) return false;

  // Currencies: 1-3 from the allow-list, no duplicates, exactly one default
  if (
    s.currencies.length === 0 ||
    s.currencies.length > MAX_COUNT.currencies ||
    !s.currencies.every(isStoreCurrencyValid)
  ) return false;
  const codes = s.currencies.map((c) => c.currencyCode);
  if (new Set(codes).size !== codes.length) return false;
  if (s.currencies.filter((c) => c.currencyIsDefault).length !== 1) return false;

  // General
  if (!isMaxLength(s.general.pickupAddress, MAX_LENGTH.pickupAddress)) return false;
  if (!isInRange(s.general.discountPercent, NUMBER_RANGE.percent)) return false;

  return isStoreCustomizeValid(s, storeId);
}

/*
 * `customize` is template-specific. Cap its size for every template, and check the default
 * (t0) template's fields when they're present. UI-only extras (e.g. `imageFile: null`) are allowed.
 */
function isStoreCustomizeValid(s: StoreSettings, storeId: string): boolean {
  const c = s.customize;
  if (c === undefined) return true;
  if (JSON.stringify(c).length > MAX_CUSTOMIZE_JSON) return false;
  if (s.templateId !== appConstants.STORE_TEMPLATE_DEFAULT) return true;

  const color = c.colorTheme?.primaryColor;
  if (c.colorTheme !== undefined && (!isObject(c.colorTheme) || (color !== undefined && (typeof color !== "string" || !isHexColor(color))))) {
    return false;
  }

  if (c.header !== undefined) {
    const uri = c.header?.headerImageStripUri;
    if (!isObject(c.header) || (uri !== undefined && (typeof uri !== "string" || !isImageKeyOrEmpty(uri, storeImageFolder.header(storeId))))) {
      return false;
    }
  }

  const promo = c.promoContent;
  if (promo !== undefined) {
    if (!isObject(promo)) return false;
    if (promo.runnerText !== undefined && (typeof promo.runnerText !== "string" || !isMaxLength(promo.runnerText, MAX_LENGTH.promoRunnerText))) {
      return false;
    }
    if (promo.promoImages !== undefined) {
      if (!Array.isArray(promo.promoImages) || promo.promoImages.length > MAX_COUNT.promoImages) return false;
      const folder = storeImageFolder.promo(storeId);
      const ok = promo.promoImages.every(
        (img: unknown) =>
          isObject(img) &&
          (img.imageUri === undefined || (typeof img.imageUri === "string" && isImageKeyOrEmpty(img.imageUri, folder)))
      );
      if (!ok) return false;
    }
  }
  return true;
}

export function isStoreCurrencyPure(currency: StoreCurrency): boolean {
  return (
    isObject(currency) &&
    typeof currency.currencyCode === "string" &&
    typeof currency.currencySign === "string" &&
    typeof currency.currencyFloat === "string" &&
    typeof currency.currencyIsDefault === "boolean"
  );
}

export function isStoreCurrencyValid(currency: StoreCurrency): boolean {
  return (
    (CURRENCY_CODES as readonly string[]).includes(currency.currencyCode) &&
    currency.currencySign.length > 0 &&
    isMaxLength(currency.currencySign, MAX_LENGTH.currencySign) &&
    (currency.currencyFloat === appConstants.STORE_CURRENCY_POSITION_LEFT ||
      currency.currencyFloat === appConstants.STORE_CURRENCY_POSITION_RIGHT)
  );
}

export interface StoreCurrency {
  currencyCode: string;
  currencySign: string;
  currencyFloat: STORE_CURRENCY_FLOAT;
  currencyIsDefault: boolean;
}

export function initStoreCurrency(): StoreCurrency {
  return {
    currencyCode: "USD",
    currencySign: "$",
    currencyFloat: "LEFT",
    currencyIsDefault: true,
  };
}

/*
 * Store Category
 */
// STORE#STORE_ID, CATEGORY#CATEGORY_ID
export interface StoreCategory {
  storeCategoriyId: string;
  storeCategoriyPriority: PRIORITY;
  storeCategoryName: string;
  storeCategoryBannerUri: string;
  storeCategoryIsActive: boolean;
  storeCategoryDiscountPercent: number;
  storeCategoriyHashtags: StoreCategoryHashtag[];
  storeCategoryItemCount: number;
}

export function initStoreCategory(
  storeCategoriyId: string,
  storeCategoryName: string
): StoreCategory {
  return {
    storeCategoriyId: storeCategoriyId,
    storeCategoriyPriority: PRIORITY_DEFAULT,
    storeCategoryName: storeCategoryName,
    storeCategoryBannerUri: "",
    storeCategoryIsActive: true,
    storeCategoryDiscountPercent: 0,
    storeCategoriyHashtags: [],
    storeCategoryItemCount: 0,
  };
}

export function isStoreCategoryPure(storeCategory: StoreCategory): boolean {
  if (!isObject(storeCategory)) return false;
  const hashtags = storeCategory.storeCategoriyHashtags;
  return (
    typeof storeCategory.storeCategoriyPriority === "string" &&
    typeof storeCategory.storeCategoryName === "string" &&
    typeof storeCategory.storeCategoryBannerUri === "string" &&
    typeof storeCategory.storeCategoryIsActive === "boolean" &&
    typeof storeCategory.storeCategoryDiscountPercent === "number" &&
    Array.isArray(hashtags) &&
    hashtags.every((hashtag) => isObject(hashtag) && isStoreCategoryHashtagPure(hashtag)) &&
    typeof storeCategory.storeCategoryItemCount === "number"
  );
}

const PRIORITIES: string[] = [PRIORITY_HIGHT, PRIORITY_MEDIUM, PRIORITY_DEFAULT];

/*
 * Value checks (call only after isStoreCategoryPure). `categoryId` is the existing category's ID
 * on update, or undefined on create; a new category can't have a banner yet (it's uploaded under
 * the ID the create returns).
 */
export function isStoreCategoryValid(
  storeCategory: StoreCategory,
  storeId: string,
  categoryId: string | undefined
): boolean {
  const hashtags = storeCategory.storeCategoriyHashtags;
  const banner = storeCategory.storeCategoryBannerUri;
  return (
    storeCategory.storeCategoryName.length > 0 &&
    isMaxLength(storeCategory.storeCategoryName, MAX_LENGTH.categoryName) &&
    PRIORITIES.includes(storeCategory.storeCategoriyPriority) &&
    isInRange(storeCategory.storeCategoryDiscountPercent, NUMBER_RANGE.percent) &&
    (categoryId
      ? isImageKeyOrEmpty(banner, storeImageFolder.categoryBanner(storeId, categoryId))
      : banner === "") &&
    hashtags.length <= MAX_COUNT.categoryHashtags &&
    hashtags.every((hashtag) => isStoreCategoryHashtagValid(hashtag))
  );
}

export interface StoreCategoryHashtag {
  id: string;
  value: string;
}

export function isStoreCategoryHashtagPure(
  storeCategoryHashtag: StoreCategoryHashtag
): boolean {
  return (
    typeof storeCategoryHashtag.id === "string" &&
    typeof storeCategoryHashtag.value === "string"
  );
}

export function isStoreCategoryHashtagValid(
  storeCategoryHashtag: StoreCategoryHashtag
): boolean {
  return (
    storeCategoryHashtag.id.length > 0 &&
    isMaxLength(storeCategoryHashtag.id, MAX_LENGTH.hashtagId) &&
    storeCategoryHashtag.value.length > 0 &&
    isMaxLength(storeCategoryHashtag.value, MAX_LENGTH.hashtag)
  );
}

/*
 * Store Items
 */
// STORE#STORE_ID, ITEM#ITEM_ID
export interface StoreItem {
  storeItemId: string;
  storeItemCategoryId: string;
  storeItemImageUris: string[];
  storeItemName: string;
  /* STOCK_UNLIMITED (-1), or a tracked whole number >= 0 where 0 = sold out (2.6). */
  storeItemStock: number;
  /*
   * Price per currency code in minor units (2.5): { USD: 6500, CAD: 8900 } = $65.00 / CA$89.00.
   * The merchant sets each one; nothing is converted. A currency the store offers but the item
   * has no price in is a currency the item isn't sold in.
   */
  storeItemPrices: StoreItemPrices;
  storeItemDescription: string;
  storeItemIsActive: boolean;
  storeItemHashtagIds: string[];
  storeItemDiscountPercent: number;
  storeItemCustomParams: StoreParameter[];
}

export function isStoreItemPure(storeItem: StoreItem): boolean {
  if (!isObject(storeItem)) return false;
  const i = storeItem;
  return (
    typeof i.storeItemCategoryId === "string" &&
    Array.isArray(i.storeItemImageUris) &&
    i.storeItemImageUris.every((uri) => typeof uri === "string") &&
    typeof i.storeItemName === "string" &&
    typeof i.storeItemStock === "number" &&
    isObject(i.storeItemPrices) &&
    Object.values(i.storeItemPrices).every((v) => typeof v === "number") &&
    typeof i.storeItemDescription === "string" &&
    typeof i.storeItemIsActive === "boolean" &&
    Array.isArray(i.storeItemHashtagIds) &&
    i.storeItemHashtagIds.every((id) => typeof id === "string") &&
    typeof i.storeItemDiscountPercent === "number" &&
    Array.isArray(i.storeItemCustomParams) &&
    i.storeItemCustomParams.every((p) => isObject(p) && isStoreParameterPure(p))
  );
}

/*
 * Value checks (call only after isStoreItemPure). `itemId` is the existing item's ID on update,
 * or undefined on create; a new item can't have images yet (they're uploaded under the ID the
 * create returns).
 */
export function isStoreItemValid(
  storeItem: StoreItem,
  storeId: string,
  itemId: string | undefined
): boolean {
  const i = storeItem;
  const imageFolder = itemId ? storeImageFolder.item(storeId, itemId) : undefined;
  return (
    isUlid(i.storeItemCategoryId) &&
    i.storeItemName.length > 0 &&
    isMaxLength(i.storeItemName, MAX_LENGTH.itemName) &&
    isMaxLength(i.storeItemDescription, MAX_LENGTH.itemDescription) &&
    isStoreItemPricesValid(i.storeItemPrices) &&
    isInRange(i.storeItemStock, NUMBER_RANGE.stock) &&
    Number.isInteger(i.storeItemStock) &&
    isInRange(i.storeItemDiscountPercent, NUMBER_RANGE.percent) &&
    i.storeItemImageUris.length <= MAX_COUNT.itemImages &&
    i.storeItemImageUris.every(
      (uri) => uri.length > 0 && imageFolder !== undefined && isImageKeyOrEmpty(uri, imageFolder)
    ) &&
    i.storeItemHashtagIds.length <= MAX_COUNT.itemHashtags &&
    i.storeItemHashtagIds.every((id) => id.length > 0 && isMaxLength(id, MAX_LENGTH.hashtagId)) &&
    i.storeItemCustomParams.length <= MAX_COUNT.itemParams &&
    i.storeItemCustomParams.every(isStoreParameterValid)
  );
}

/* Stock rule (2.6): unlimited never runs out; a tracked count needs at least `quantity`. */
export const isUnlimitedStock = (stock: number): boolean => stock === STOCK_UNLIMITED;

export function hasStockFor(stock: number, quantity = 1): boolean {
  if (!Number.isInteger(quantity) || quantity < 1) return false;
  return isUnlimitedStock(stock) || (Number.isInteger(stock) && stock >= quantity);
}

export type StoreItemPrices = Partial<Record<(typeof CURRENCY_CODES)[number], number>>;

/* 1-3 prices, keyed by allowed currency codes, each a whole number of cents in range. */
export function isStoreItemPricesValid(prices: StoreItemPrices): boolean {
  const entries = Object.entries(prices);
  return (
    entries.length > 0 &&
    entries.length <= MAX_COUNT.currencies &&
    entries.every(
      ([code, cents]) =>
        (CURRENCY_CODES as readonly string[]).includes(code) &&
        Number.isInteger(cents) &&
        isInRange(cents as number, NUMBER_RANGE.priceMinor)
    )
  );
}

export interface StoreParameter {
  storeParamLabel: string;
  storeParamType: STORE_PARAM_TYPE;
  storeParamIsMandatory: boolean;
  storeParamOptions: string[];
}

export function isStoreParameterPure(storeParameter: StoreParameter): boolean {
  return (
    typeof storeParameter.storeParamLabel === "string" &&
    typeof storeParameter.storeParamType === "string" &&
    typeof storeParameter.storeParamIsMandatory === "boolean" &&
    Array.isArray(storeParameter.storeParamOptions) &&
    storeParameter.storeParamOptions.every((o) => typeof o === "string")
  );
}

export function isStoreParameterValid(storeParameter: StoreParameter): boolean {
  const label = storeParameter.storeParamLabel;
  if (label.length === 0 || !isMaxLength(label, MAX_LENGTH.paramLabel)) {
    return false;
  }
  const options = storeParameter.storeParamOptions;
  if (
    options.length > MAX_COUNT.paramOptions ||
    !options.every((o) => o.length > 0 && isMaxLength(o, MAX_LENGTH.paramOption))
  ) {
    return false;
  }
  if (
    storeParameter.storeParamType !== "SINGLE_SELECT" &&
    storeParameter.storeParamType !== "MULTI_SELECT"
  ) {
    return false;
  }
  return true;
}

export interface StoreInventoryData {
  categories: StoreCategory[];
  items: StoreItem[];
  settings: StoreSettings;
}

export function initStoreInventoryData(): StoreInventoryData {
  return {
    categories: [],
    items: [],
    settings: initStoreSettings(),
  };
}

/*
 * Store Members
 */
// STORE#STORE_ID, MEMBER#MEMBER_ID
export interface StoreMember {
  storeMemberId: string;
  storeMemberFirstName: string;
  storeMemberLastName: string;
  storeMemberEmail: string;
  storeMemberPhoneNumber: string;
  storeMemberPermission: "ADMIN" | "MERCHANT";
  storeMemberUpdatedAt: number;
  storeMemberCreatedAt: number;
}

/*
 * Store Orders
 */
// STORE#STORE_ID, ORDER#CREATE_AT_TIMESTAMP (For Sales acitivty graph), (TEST_ORDER#ORDER_ID)
export interface StoreOrder {
  storeOrderId: string;
  storeOrderCode: string;
  storeOrderType: "DELIVERY" | "PICKUP";
  storeOrderStatus: boolean;
  storeOrderStoreName: string;
  storeOrderCustomerName: string;
  storeOrderCustomerEmailAddress: string;
  storeOrderCustomerPhoneNumber: string;
  storeOrderCustomerShippingCountry: string;
  storeOrderCustomerShippingState: string;
  storeOrderCustomerShippingCity: string;
  storeOrderCustomerShippingAddressStreetNumber: string;
  storeOrderCustomerAuthenticatedUserId: string;
  storeOrderStatusCustomerUpdate: boolean;
  storeOrderItems: StoreOrderItem[];
  storeOrderNote: string;
  storeOrderSubtotalAmount: number;
  storeOrderDeliveryAmount: number;
  storeOrderHandlingAmount: number;
  storeOrderTaxAmount: number;
  storeOrderCreatedAt: number;
  storeOrderUpdatedAt: number;
}

export interface StoreOrderItem {
  id: string;
  price: number;
  parameters: {
    id: string;
    label: string;
    value: string;
  }[];
}

// APP, ORDER#CREATE_AT_TIMESTAMP#STORE#STORE_ID (For Sales acitivty graph)
