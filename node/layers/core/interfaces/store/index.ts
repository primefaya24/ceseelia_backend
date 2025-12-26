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

  contactInfo: {
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
    contactInfo: {
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

export function isStoreSettingsPure(storeSettings: StoreSettings): boolean {
  return true;
}

export function isStoreSettingsValid(storeSettings: StoreSettings): boolean {
  return true;
}

export interface StoreCurrency {
  currencyCode: string;
  currencySign: string;
  currencyFloat: STORE_CURRENCY_FLOAT;
}

export function initStoreCurrency(): StoreCurrency {
  return {
    currencyCode: "USD",
    currencySign: "$",
    currencyFloat: "LEFT",
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
    storeCategoryItemCount: 0,
  };
}

export function isStoreCategoryPure(storeCategory: StoreCategory): boolean {
  return (
    typeof storeCategory.storeCategoryName === "string" &&
    typeof storeCategory.storeCategoryBannerUri === "string" &&
    typeof storeCategory.storeCategoryIsActive === "boolean" &&
    typeof storeCategory.storeCategoryDiscountPercent === "number" &&
    typeof storeCategory.storeCategoryItemCount === "number"
  );
}

export function isStoreCategoryValid(storeCategory: StoreCategory): boolean {
  return (
    storeCategory.storeCategoryName.length > 0 &&
    storeCategory.storeCategoryDiscountPercent >= 0
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
  storeItemTags: string;
  storeItemDiscountPercent: number;
  storeItemCustomParams: StoreParameter[];
}

export function isStoreItemPure(storeItem: StoreItem): boolean {
  let pure =
    typeof storeItem.storeItemCategoryId === "string" &&
    Array.isArray(storeItem.storeItemImageUris) &&
    typeof storeItem.storeItemName === "string" &&
    typeof storeItem.storeItemStock === "number" &&
    typeof storeItem.storeItemPrice === "number" &&
    typeof storeItem.storeItemDescription === "string" &&
    typeof storeItem.storeItemIsActive === "boolean" &&
    typeof storeItem.storeItemTags === "string" &&
    typeof storeItem.storeItemDiscountPercent === "number" &&
    Array.isArray(storeItem.storeItemCustomParams);
  for (let storeItemImageUri of storeItem.storeItemImageUris) {
    pure = pure && typeof storeItemImageUri === "string";
  }
  for (let storeItemCustomParam of storeItem.storeItemCustomParams) {
    pure = pure && isStoreParameterPure(storeItemCustomParam);
  }
  return pure;
}

export function isStoreItemValid(storeItem: StoreItem): boolean {
  let valid =
    storeItem.storeItemCategoryId.length > 0 &&
    storeItem.storeItemName.length > 0;
  for (let storeItemImageUri of storeItem.storeItemImageUris) {
    valid = valid && storeItemImageUri.length > 0;
  }
  for (let storeItemCustomParam of storeItem.storeItemCustomParams) {
    valid = valid && isStoreParameterValid(storeItemCustomParam);
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
