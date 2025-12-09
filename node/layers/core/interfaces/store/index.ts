/*
 * Merchant Join Requests
 */

import { appConstants } from "../../../../constants";

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
  logoUri: string;
  bannerUri: string;
  promoImageUri: string;
  contactInfo: {
    phoneNumber: {
      number: string;
      isAvailableOnWhatsapp: boolean;
    };
    emailaddress: string;
  };
  isOffline: boolean;
  discountPercent: number;
  purchaseRewards: {
    isAvailable: boolean;
    rewardsLabel: string; // i.e - PH Points
    pointsPerDollar: number; // i.e - 5
    redemptionMethod: string;
    redemptionPointAmount: number; // 350
    redemptionPointAmountValue: number; // $10, 10%
  };
  isAllowPickup: boolean;
  pickupAddress: string;
  websiteLink: string;
  socialMediaLinks: {
    facebook: string;
    instagram: string;
    tiktok: string;
    twitter: string;
    youtube: string;
    pinterest: string;
    etsy: string;
  };
  defaultCurrencyCode: string;
  defaultCurrencyLocale: string;

  // Admin
  isSuspended: boolean; // False
  salesCommission: number; // $1.25 default
}

export function initStoreSettings(): StoreSettings {
  return {
    // Merchant
    templateId: appConstants.STORE_TEMPLATE_DIGITAL_STORE,
    themeId: appConstants.STORE_THEME_DEFAULT,
    logoUri: "",
    bannerUri: "",
    promoImageUri: "",
    contactInfo: {
      phoneNumber: {
        number: "",
        isAvailableOnWhatsapp: false,
      },
      emailaddress: "",
    },
    isOffline: true,
    discountPercent: 0,
    purchaseRewards: {
      isAvailable: false,
      rewardsLabel: "",
      pointsPerDollar: 0,
      redemptionMethod:
        appConstants.STORE_REWARDS_REDEMPTION_METHOD_POINTS_TO_MONEY,
      redemptionPointAmount: 0,
      redemptionPointAmountValue: 0,
    },
    isAllowPickup: false,
    pickupAddress: "",
    websiteLink: "",
    socialMediaLinks: {
      facebook: "",
      instagram: "",
      tiktok: "",
      twitter: "",
      youtube: "",
      pinterest: "",
      etsy: "",
    },
    defaultCurrencyCode: "",
    defaultCurrencyLocale: "",

    // Admin
    isSuspended: false,
    salesCommission: appConstants.STORE_DEFAULT_SALES_COMMISSION_CENTS,
  };
}

/*
 * Store Categories
 */
// STORE#STORE_ID, CATEGORY#CATEGORY_ID
export interface StoreCategory {
  storeCategoriyId: string;
  storeCategoryName: string;
  storeCategoryDescription: string;
  storeCategoryBannerUri: string;
  storeCategoryIsHidden: boolean;
  storeCategoryDiscountPercent: number;
  storeCategoryItemCount: number;
}

export function initStoreCategory(
  storeCategoriyId: string,
  storeCategoryName: string
): StoreCategory {
  return {
    storeCategoriyId: storeCategoriyId,
    storeCategoryName: storeCategoryName,
    storeCategoryDescription: "",
    storeCategoryBannerUri: "",
    storeCategoryIsHidden: false,
    storeCategoryDiscountPercent: 0,
    storeCategoryItemCount: 0,
  };
}

/*
 * Store Inventory
 */
// STORE#STORE_ID, ITEM#ITEM_ID
export interface StoreItem {
  storeItemId: string;
  storeItemCategoryId: string;
  storeItemImageUris: string[];
  storeItemName: string;
  storeItemPrice: number;
  storeItemDescription: string;
  storeItemIsActive: boolean;
  storeItemTags: string;
  storeItemDiscountPercent: number;
  storeItemCustomAttributes: {
    label: string;
    type: "MULTI_SELECT" | "COUNTER";
    isMandatory: boolean;
    options: string[];
  }[];
}

export function initStoreItem(
  storeItemId: string,
  storeItemCategoryId: string
): StoreItem {
  return {
    storeItemId: storeItemId,
    storeItemCategoryId: storeItemCategoryId,
    storeItemImageUris: [],
    storeItemName: "",
    storeItemPrice: 0,
    storeItemDescription: "",
    storeItemIsActive: true,
    storeItemTags: "",
    storeItemDiscountPercent: 0,
    storeItemCustomAttributes: [],
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
  storeOrderItems: {
    id: string;
    categoryId: number;
    imageUri: string;
    name: string;
    price: number;
    attributes: {
      label: string;
      type: "MULTI_SELECT" | "COUNTER";
      value: string | number;
    }[];
  }[];
  storeOrderNote: string;
  storeOrderSubtotalAmount: number;
  storeOrderDeliveryAmount: number;
  storeOrderHandlingAmount: number;
  storeOrderTaxAmount: number;
  storeOrderCreatedAt: number;
  storeOrderUpdatedAt: number;
}

// APP, ORDER#CREATE_AT_TIMESTAMP#STORE#STORE_ID (For Sales acitivty graph)
