/*
 * Merchant Join Requests
 */

import {
  appConstants,
  PRIORITY,
  PRIORITY_DEFAULT,
  STORE_CURRENCY_FLOAT,
  STORE_PARAM_TYPE,
} from "../../../../constants";

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

/*
 * Value checks (call only after isStoreSettingsPure)
 */
export function isStoreSettingsValid(storeSettings: StoreSettings): boolean {
  const s = storeSettings;
  if (s.templateId.length === 0 || s.themeId.length === 0) return false;

  const r = s.purchaseRewards;
  // TODO(Stage 7): unify — the webapp saves REWARDS_REDEMPTION_*, the backend default is POINTS_TO_*
  const redemptionMethods = [
    appConstants.STORE_REWARDS_REDEMPTION_METHOD_POINTS_TO_MONEY,
    appConstants.STORE_REWARDS_REDEMPTION_METHOD_POINTS_TO_DISCOUNT,
    "REWARDS_REDEMPTION_DOLLAR",
    "REWARDS_REDEMPTION_DISCOUNT",
  ];
  if (!redemptionMethods.includes(r.redemptionMethod)) return false;
  if (r.redemptionPointAmount < 0 || r.redemptionPointAmountValue < 0 || r.pointsPerDollarSpent < 0) return false;

  if (s.currencies.length === 0 || !s.currencies.every(isStoreCurrencyValid)) return false;
  const codes = s.currencies.map((c) => c.currencyCode);
  if (new Set(codes).size !== codes.length) return false;

  if (s.general.discountPercent < 0 || s.general.discountPercent > 100) return false;

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
    currency.currencyCode.length > 0 &&
    currency.currencySign.length > 0 &&
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
  const hashtags = storeCategory.storeCategoriyHashtags;
  return (
    typeof storeCategory.storeCategoryName === "string" &&
    typeof storeCategory.storeCategoryBannerUri === "string" &&
    typeof storeCategory.storeCategoryIsActive === "boolean" &&
    typeof storeCategory.storeCategoryDiscountPercent === "number" &&
    Array.isArray(hashtags) &&
    hashtags.every((hashtag) => isStoreCategoryHashtagPure(hashtag)) &&
    typeof storeCategory.storeCategoryItemCount === "number"
  );
}

export function isStoreCategoryValid(storeCategory: StoreCategory): boolean {
  const hashtags = storeCategory.storeCategoriyHashtags;
  return (
    storeCategory.storeCategoryName.length > 0 &&
    storeCategory.storeCategoryDiscountPercent >= 0 &&
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
    storeCategoryHashtag.id.length > 0 && storeCategoryHashtag.value.length > 0
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
  storeItemStock: number;
  storeItemPrice: number;
  storeItemDescription: string;
  storeItemIsActive: boolean;
  storeItemHashtagIds: string[];
  storeItemDiscountPercent: number;
  storeItemCustomParams: StoreParameter[];
}

export function isStoreItemPure(storeItem: StoreItem): boolean {
  const hashtagIdss = storeItem.storeItemHashtagIds;
  let pure =
    typeof storeItem.storeItemCategoryId === "string" &&
    Array.isArray(storeItem.storeItemImageUris) &&
    typeof storeItem.storeItemName === "string" &&
    typeof storeItem.storeItemStock === "number" &&
    typeof storeItem.storeItemPrice === "number" &&
    typeof storeItem.storeItemDescription === "string" &&
    typeof storeItem.storeItemIsActive === "boolean" &&
    Array.isArray(hashtagIdss) &&
    hashtagIdss.every((hashtagId) => typeof hashtagId === "string") &&
    typeof storeItem.storeItemDiscountPercent === "number" &&
    Array.isArray(storeItem.storeItemCustomParams);
  for (const storeItemImageUri of storeItem.storeItemImageUris) {
    pure = pure && typeof storeItemImageUri === "string";
  }
  for (const storeItemCustomParam of storeItem.storeItemCustomParams) {
    pure = pure && isStoreParameterPure(storeItemCustomParam);
  }
  return pure;
}

export function isStoreItemValid(storeItem: StoreItem): boolean {
  const hashtagIdss = storeItem.storeItemHashtagIds;
  let valid =
    storeItem.storeItemCategoryId.length > 0 &&
    storeItem.storeItemName.length > 0;
  for (const storeItemImageUri of storeItem.storeItemImageUris) {
    valid = valid && storeItemImageUri.length > 0;
  }
  for (const storeItemCustomParam of storeItem.storeItemCustomParams) {
    valid = valid && isStoreParameterValid(storeItemCustomParam);
  }
  for (const hashtagId of hashtagIdss) {
    valid = valid && hashtagId.length > 0;
  }
  return valid;
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
    Array.isArray(storeParameter.storeParamOptions)
  );
}

export function isStoreParameterValid(storeParameter: StoreParameter): boolean {
  if (storeParameter.storeParamLabel.length === 0) {
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
