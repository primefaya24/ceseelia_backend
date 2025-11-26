import {LocationData, TimezoneData, Weekday} from "../elements";

export interface Website {
    pk: string;
    sk: string;
    websiteName: string;
    websiteDomain: string;
    websiteBusinessLocale: string;
    websiteTimezoneData: TimezoneData;
    websiteReportingCorrespondentName: string;
    websiteReportingEmailAddress: string;
    websiteBusinessLocation: LocationData;
    websiteStartDate: number;
    websiteLogoUri: string;
    websiteGalleryIncluded: boolean;
    websitePricingIncluded: boolean;
    websiteSettingsIncluded: boolean;
    websiteOnlineOrderingIncluded: boolean;
    websiteOnlineOrderingPaymentEnforced: boolean
    websiteCurrencySign: string;
    websiteMaxImageCount: number;
    websiteMinHighlightedPhotos: number;
    websiteMaxHighlightedPhotos: number;
    websiteBusinessName: string;
    websiteBusinessAddress: string;
    websiteIsOnlineOrderingAvailable: boolean;
    websiteIsPickUpAvailable: boolean;
    websiteIsDeliveryAvailable: boolean;
    websiteIsScheduleAvailable: boolean;
    websiteOnlineOrderingStartTimeHHMM: {
        [day in Weekday]: string;
    };
    websiteOnlineOrderingEndTimeHHMM: {
        [day in Weekday]: string;
    };
    websiteOnlineOrderingTaxes: any[];
    websiteTheme: string;
    websitePrimaryBackgroundColor: string;
    websiteSecondaryBackgroundColor: string;
    websiteTertiaryBackgroundColor: string;
    websitePrimaryTextColor: string;
    websitePrimaryTextInvertColor: string;
    websiteSecondaryTextColor: string;
    websiteSecondaryTextInvertColor: string;
    websiteTertiaryTextColor: string;
    websiteTertiaryTextInvertColor: string;
    serviceFee: number;
    handlingFee: number;
    deliveryFee: number;
    rewardDollarValue: number;
    minRewardDollarsToRedeem: number;
    websiteTotalVisitors: number;
    websiteTotalVisitorTimeSpentMillis: string;
    websiteCreatedAt: number;
    itemAncestor: string;
}

export interface WebsiteMembership {
    "pk": string;
    "sk": string;
    "websiteMemberFirstName": string;
    "websiteMemberLastName": string;
    "websiteMemberStatus": string;
    "websiteMemberPermission": string;
    "websiteMemberUserEmail": string;
    "websiteMemberPhoneNumber": string;
    "websiteMemberSideNote": string;
    "websiteMembershipLastUpdated": number;
}

export interface WebsiteData {
    "pk": string;
    "sk": string;
    "websiteData": WebsiteDataContent;
    "itemAncestor": string;
}

export interface WebsiteDataContent {
    "version": number;
    "photoGallery": WebsiteDataContentPhotoGallery;
    "settings": WebsiteDataContentSettings;
    "pricing": WebsiteDataContentPricing;
}

export interface WebsiteDataContentPhotoGallery {
    "imageUris": string[];
    "highlightedImageUris": string[];
}

export interface WebsiteDataContentSettings {
    "promoImageUri": string;
}

export interface WebsiteDataContentPricing {
    "pageTitle": string;
    "pageSubtitle": string;
    "categories": WebsiteDataContentPricingCategory[];
}

export interface WebsiteDataContentPricingCategory {
    uniqueId?: string;
    title: string;
    subtitle: string;
    isDefault?: boolean;
    subCategories: WebsiteDataContentPricingSubCategory[];
    optionGroups: WebsiteDataContentPricingItemOrderOptionsGroup[];
    taxes: WebsiteOnlineOrderingTax[];
}

export interface WebsiteDataContentPricingSubCategory {
    uniqueId?: string;
    id: string;
    name: string;
    colCount: number;
    highlightText: string;
    extraInfoText: string;
    isDisplaySubCategory: boolean;
    items: WebsiteDataContentPricingItem[];
    optionGroups: WebsiteDataContentPricingItemOrderOptionsGroup[];
    taxes: WebsiteOnlineOrderingTax[];
}

export interface WebsiteDataContentPricingItem {
    uniqueId?: string;
    header?: string;
    title: string;
    subtitle: string;
    price: string;
    isWebsite?: boolean;
    isOnlineOrdering?: boolean;
    isInStock?: boolean;
    isBestSeller?: boolean;
    isDisplayPrice?: boolean;
    optionGroups: WebsiteDataContentPricingItemOrderOptionsGroup[];
    note?: string;
    quantity?: number;
    taxes?: WebsiteOnlineOrderingTax[];
    miscNote?: WebsiteDataContentPricingItemMiscNote;
}

export interface WebsiteDataContentPricingItemOrderOptionsGroup {
    uniqueId?: string;
    title: string;
    type: string;
    priority: string;
    isAligned: boolean;
    isMandatory: boolean;
    minSelections?: number;
    maxSelections?: number;
    options: WebsiteDataContentPricingItemOrderOptionsGroupItem[];
}

export interface WebsiteDataContentPricingItemOrderOptionsGroupItem {
    uniqueId?: string;
    label: string;
    price: string;
    value: string;
}

export interface WebsiteOnlineOrderingTax {
    label: string;
    percentage: string;
}

export interface WebsiteDataContentPricingItemMiscNote {
    note: string;
    price: string;
}

