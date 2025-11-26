import https from 'https';
import zlib from 'zlib';
import moment from 'moment-timezone';
import {AppBoolean, AppNumber} from "../interfaces/elements";
import {appConstants} from "../../../constants";
import {SessionData} from "../interfaces/view-routes";
import {IN_DEV, STAGE} from "../../../config";
import {jwtDecode} from "jwt-decode";
import {WebsiteDataContentPricingItemMiscNote} from "../interfaces/website";

/*
* Send Https request with given body and options
*/
export function sendHttpsRequest(options: any, body: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            let responseBody = '';

            res.on('data', (chunk) => {
                responseBody += chunk;
            });

            res.on('end', () => {
                resolve(JSON.parse(responseBody));
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        if (body) {
            req.write(body);
        }
        req.end();
    });
}

/*
* Checks whether user is admin
*/
export function isUserAdmin(cognitoGroups: any): boolean {
    if (!cognitoGroups) {
        return false;
    }
    for (let cognitoGroupName of cognitoGroups) {
        if (cognitoGroupName === appConstants.COGNITO_GROUP_ADMINS) {
            return true;
        }
    }
    return false;
}

/*
* Checks if string matches given pattern
*/
export function hasMatch(pattern: any, value: any, onEmpty: any) {
    if (value.length === 0) {
        return onEmpty;
    }
    if (value.match(pattern)) {
        return true;
    }
    return false;
}

/*
* S3 key to url
*/
export function s3KeyToUrl(key: any, baseDomain: any) {
    return !IN_DEV ? `https://${baseDomain}/${key}` : `https://${STAGE}.${baseDomain}/${key}`;
}

/*
* Turn dynamodb items into primary key only items
*/
export function getItemsPrimaryKeys(items: any) {
    for (let i = 0; i < items.length; i++) {
        items[i] = {
            "pk": items[i].pk,
            "sk": items[i].sk,
        };
    }
    return items;
}

/*
* Validate image type
*/
export function validateAssetType(imgType: any) {
    if (
        imgType !== 'png' &&
        imgType !== 'jpg' &&
        imgType !== 'jpeg'
    ) {
        throw "Invalid image type";
    }
    if (imgType !== 'jpg') {
        return 'jpeg';
    }
    return imgType;
}

/*
* Apply timestamp to url
*/
export function applyTimestampToLink(link: any) {
    const timestamp = Date.now();
    return `${link}?timestamp=${timestamp}`;
}

/*
* Capitalize first character in a word
*/
export function capitalize(s: any) {
    return s[0].toUpperCase() + (s.slice(1)).toLowerCase();
}

/*
* Calc percentage
*/
export function calcPercentage(portion: any, total: any) {
    if (total === 0) {
        return 0;
    }
    return Math.round((portion / total) * 100);
}

/*
* Convert bytes
*/
export function convertBytes(bytes: any) {
    if (bytes < 1024) {
        return {
            size: bytes.toString(),
            units: "B"
        };
    } else if (1024 <= bytes && bytes < 1048576) { // 1 KB <= x < 1 MB
        return {
            size: (bytes / 1024).toFixed(2),
            units: "KB"
        };
    } else if (1048576 <= bytes && bytes < 1073741824) { // 1 MB <= x < 1 GB
        return {
            size: (bytes / 1048576).toFixed(2),
            units: "MB"
        };
    }
    return {
        size: '',
        units: "-"
    }
}

/*
* Unzip buffer
*/
export function unzipBuffer(gzBuffer: any): Promise<any> {
    return new Promise(async (resolve, reject) => {
        zlib.unzip(gzBuffer, (err, buffer) => {
            if (err) {
                console.error("In unzipBuffer", err);
                reject(err);
            } else {
                resolve(buffer);
            }
        });
    });
}

/*
* Check if a string is alpha-numeric with underscore or a dot
*/
export function isAlphaNumericWithDotOrUnderscore(str: string): boolean {
    let code, i, len;
    for (i = 0, len = str.length; i < len; i++) {
        code = str.charCodeAt(i);
        if (
            !(code > 47 && code < 58) && // numeric (0-9)
            !(code > 64 && code < 91) && // upper alpha (A-Z)
            !(code > 96 && code < 123) && // lower alpha (a-z)
            str.charAt(i) !== '.' && // Dot
            str.charAt(i) !== '_' // Underscore
        ) {
            return false;
        }
    }
    return true;
}

/*
* Check if service handle is legal
*/
export function legalServiceHandle(serviceHandle: string): boolean {
    return (
        serviceHandle.length > 0 &&
        isAlphaNumericWithDotOrUnderscore(serviceHandle)
    );
}

/*
* Get Lat/Lng timezone data
*/
export async function getLatLngTimezoneData(lat: any, lng: any, epochSeconds: any): Promise<any> {
    try {
        return await sendHttpsRequest(
            {
                host: 'maps.googleapis.com',
                path: `/maps/api/timezone/json?location=${lat},${lng}&timestamp=${epochSeconds}&key=AIzaSyClD9NQPlpNtXro0MvR69NseYEHlqaYAIo`,
                method: 'GET',
            },
            null // body
        );
    } catch (e) {
        console.error("In getLatLngTimezoneData", e);
        throw "Could not get lat/lng timezone data";
    }
}

/*
* Add days to a give date
*/
export function addDays(date: any, days: any): any {
    var result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

/*
* Convert AM/PM to 24 hour format
*/
export function convertTime12to24(time12h: any): any {
    const [time, modifier] = time12h.split(' ');

    let [hours, minutes] = time.split(':');

    if (hours === '12') {
        hours = '00';
    }

    if (modifier === 'PM') {
        hours = parseInt(hours, 10) + 12;
    }

    return `${hours}:${minutes}`;
}

/*
* Extract AM/PM time from date
*/
export function formatAMPM(date: any): string {
    var hours = date.getHours();
    var minutes = date.getMinutes();
    var ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    minutes = minutes < 10 ? '0' + minutes : minutes;
    var strTime = hours + ':' + minutes + ' ' + ampm;
    return strTime;
}

/*
* Is user member
*/
export function isUserWebsiteAdmin(websiteMembershipDoc: any): boolean {
    return websiteMembershipDoc["websiteMemberPermission"] === appConstants.USER_PERMISSION_ADMIN && websiteMembershipDoc["websiteMemberStatus"] === appConstants.DYNAMO_ENTITY_APPROVED;
}
export function isUserWebsiteModerator(websiteMembershipDoc: any): boolean {
    return websiteMembershipDoc["websiteMemberPermission"] === appConstants.USER_PERMISSION_MODERATOR && websiteMembershipDoc["websiteMemberStatus"] === appConstants.DYNAMO_ENTITY_APPROVED;
}

export function isNumeric(n: unknown): boolean {
    return !isNaN(parseFloat(String(n))) && isFinite(Number(n));
}

/*
* Pure Taxes
*/
export function isPureTaxes(taxes: any): boolean {
    const isDefined = typeof taxes === "object" && Array.isArray(taxes);
    if (isDefined) {
        for (let tax of taxes) {
            if (
                typeof tax.label !== "string" ||
                typeof tax.percentage !== "string"

            ) {
                return false;
            }
        }
        return true;
    }
    return false;
}

/*
* Pure Option Groups Options
*/
export function isPureOptionGroupOptions(optionGroupOptions: any): boolean {
    const isDefined = typeof optionGroupOptions === "object" && Array.isArray(optionGroupOptions);
    if (isDefined) {
        for (let optionGroupOption of optionGroupOptions) {
            if (
                typeof optionGroupOption.uniqueId !== "string" ||
                typeof optionGroupOption.label !== "string" ||
                typeof optionGroupOption.price !== "string" ||
                typeof optionGroupOption.value !== "string"
            ) {
                return false;
            }
        }
        return true;
    }
    return false;
}

/*
* Pure Option Groups
*/
export function isPureOptionGroups(optionGroups: any): boolean {
    const isDefined = typeof optionGroups === "object" && Array.isArray(optionGroups);
    if (isDefined) {
        for (let optionGroup of optionGroups) {
            if (
                typeof optionGroup.uniqueId !== "string" ||
                typeof optionGroup.title !== "string" ||
                typeof optionGroup.type !== "string" ||
                typeof optionGroup.priority !== "string" ||
                typeof optionGroup.isAligned !== "boolean" ||
                typeof optionGroup.isMandatory !== "boolean" ||
                typeof optionGroup.minSelections !== "number" ||
                typeof optionGroup.maxSelections !== "number" ||
                !isPureOptionGroupOptions(optionGroup.options)
            ) {
                return false;
            }
        }
        return true;
    }
    return false;
}

/*
* Pure Order Items
*/
export function isPureOrderItems(orderItems: any): boolean {
    const isDefined = typeof orderItems === "object" && Array.isArray(orderItems);
    if (isDefined) {
        for (let orderItem of orderItems) {
            if (
                typeof orderItem.uniqueId !== "string" ||
                typeof orderItem.title !== "string" ||
                typeof orderItem.subtitle !== "string" ||
                typeof orderItem.price !== "string" ||
                typeof orderItem.isWebsite !== "boolean" ||
                typeof orderItem.isOnlineOrdering !== "boolean" ||
                typeof orderItem.isInStock !== "boolean" ||
                typeof orderItem.isBestSeller !== "boolean" ||
                typeof orderItem.isDisplayPrice !== "boolean" ||
                !isPureOptionGroups(orderItem.optionGroups) ||
                typeof orderItem.note !== "string" ||
                typeof orderItem.quantity !== "number" ||
                !isPureTaxes(orderItem.taxes)
            ) {
                return false;
            }
        }
        return true;
    }
    return false;
}

/*
* Valid Taxes
*/
export function isValidTaxes(taxes: any): boolean {
    for (let tax of taxes) {
        if (
            tax.label.length === 0 ||
            tax.percentage.length === 0 ||
            !isNumeric(tax.percentage.trim().toLowerCase())
        ) {
            return false;
        }
    }
    return true;
}

/*
* Valid Option Groups Options
*/
export function isValidOptionGroupOptions(optionGroupOptions: any, optionGroupType: any): boolean {
    for (let optionGroupOption of optionGroupOptions) {
        if (
            optionGroupOption.uniqueId.length === 0 ||
            optionGroupOption.label.length === 0 ||
            optionGroupOption.price.length === 0 ||
            optionGroupOption.value.length === 0 ||
            !isNumeric(optionGroupOption.price.trim().toLowerCase())
        ) {
            return false;
        } else {
            // Value is valid and on/off or numberic integer
            if (
                optionGroupType === appConstants.ONLINE_ORDERING_OPTIONS_GROUP_TYPE_SINGLE_SELECT ||
                optionGroupType === appConstants.ONLINE_ORDERING_OPTIONS_GROUP_TYPE_MULTI_SELECT
            ) {
                if (
                    optionGroupOption.value.trim().toLowerCase() !== appConstants.ONLINE_ORDERING_OPTIONS_GROUP_OPTION_VALUE_ON &&
                    optionGroupOption.value.trim().toLowerCase() !== appConstants.ONLINE_ORDERING_OPTIONS_GROUP_OPTION_VALUE_OFF
                ) {
                    return false;
                }
            } else if (optionGroupType === appConstants.ONLINE_ORDERING_OPTIONS_GROUP_TYPE_COUNTABLES) {
                if (!isNumeric(optionGroupOption.value.trim().toLowerCase())) {
                    return false;
                } else {
                    if (!Number.isInteger(Number(optionGroupOption.value.trim().toLowerCase()))) {
                        return false;
                    }
                }
            } else {
                return false;
            }
        }
    }
    return true;
}

/*
* Valid Option Groups
*/
export function isValidOptionGroups(optionGroups: any): boolean {
    for (let optionGroup of optionGroups) {
        if (
            optionGroup.uniqueId.length === 0 ||
            optionGroup.title.length === 0 ||
            (
                optionGroup.type !== appConstants.ONLINE_ORDERING_OPTIONS_GROUP_TYPE_SINGLE_SELECT &&
                optionGroup.type !== appConstants.ONLINE_ORDERING_OPTIONS_GROUP_TYPE_MULTI_SELECT &&
                optionGroup.type !== appConstants.ONLINE_ORDERING_OPTIONS_GROUP_TYPE_COUNTABLES
            ) ||
            (
                optionGroup.priority !== appConstants.ONLINE_ORDERING_OPTIONS_GROUP_PRIORITY_NORMAL &&
                optionGroup.priority !== appConstants.ONLINE_ORDERING_OPTIONS_GROUP_PRIORITY_HIGH
            ) ||
            !Number.isInteger(optionGroup.minSelections) ||
            !Number.isInteger(optionGroup.maxSelections)||
            !isValidOptionGroupOptions(optionGroup.options, optionGroup.type)
        ) {
            return false;
        }
    }
    return true;
}

/*
* Valid Order Items
*/
export function isValidOrderItems(orderItems: any): boolean {
    if (orderItems.length === 0) {
        return false;
    }
    for (let orderItem of orderItems) {
        if (
            orderItem.uniqueId.length === 0 ||
            orderItem.title.length === 0 ||
            !isValidOptionGroups(orderItem.optionGroups) ||
            !Number.isInteger(Number(orderItem.quantity)) ||
            !isValidTaxes(orderItem.taxes)
        ) {
            return false;
        }
    }
    return true;
}

/*
* Generate order code
*/
export function generateOrderCode(): string {
    const randomHex = Math.floor(Math.random() * 0xFFFFFFF).toString(16).padStart(7, '0');
    return `#${randomHex}`;
}

/*
*
*
* Sync order items with website online ordering info
*
*
*/
export function initAppNumber(value: number): AppNumber {
    return {
        value: value
    }
}

export function initAppBoolean(value: boolean): AppBoolean {
    return {
        value: value
    }
}

export function processOptionGroupData(optionGroup: any): void {
    if (optionGroup.type === appConstants.ONLINE_ORDERING_OPTIONS_GROUP_TYPE_SINGLE_SELECT || optionGroup.type === appConstants.ONLINE_ORDERING_OPTIONS_GROUP_TYPE_MULTI_SELECT) {
        for (let option of optionGroup.options) {
            option.priceIonic = initAppNumber(Number(option.price));
            option.valueIonic = initAppBoolean(option.value.trim().toLowerCase() === 'on');
            option.isHide = false;
        }
    } else if (optionGroup.type === appConstants.ONLINE_ORDERING_OPTIONS_GROUP_TYPE_COUNTABLES) {
        for (let option of optionGroup.options) {
            option.priceIonic = initAppNumber(Number(option.price));
            option.valueIonic = initAppNumber(Number(option.value));
            option.isHide = false;
        }
    }
}

export function processMenuData(websiteOnlineOrderingInfo: any): any {
    const websiteMenuItems = [];
    for (let i = 0; i < websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories.length; i++) {
        // console.warn("CAT ->" + websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].title, JSON.stringify(websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].optionGroups))
        for (let optionGroup of websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].optionGroups) {
            processOptionGroupData(optionGroup);
        }
        for (let j = 0; j < websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories.length; j++) {
            // console.warn("SUB_CAT ->" + websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].name, JSON.stringify(websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].optionGroups));
            for (let optionGroup of websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].optionGroups) {
                processOptionGroupData(optionGroup);
            }
            if (!websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].isDisplaySubCategory) {
                continue;
            }
            websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].items = websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].items.filter((item: any) => item.isOnlineOrdering);
            for (let k = 0; k < websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].items.length; k++) {
                // console.warn("ITEM ->" + websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].items[k].title, JSON.stringify(websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].items[k].optionGroups));
                for (let optionGroup of websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].items[k].optionGroups) {
                    processOptionGroupData(optionGroup);
                }
                websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].items[k]["header"] = websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].name;
                websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].items[k].priceIonic = initAppNumber(isNumeric(websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].items[k].price) ? Number(websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].items[k].price) : 0);
                websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].items[k].optionGroups.push(...websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].optionGroups);
                websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].items[k].optionGroups.push(...websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].optionGroups);
                websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].items[k].taxes = [...websiteOnlineOrderingInfo.websiteInfo.websiteOnlineOrderingTaxes, ...websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].taxes, ...websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].taxes];
                websiteMenuItems.push(websiteOnlineOrderingInfo.websiteRecentDataVersion.websiteData.pricing.categories[i].subCategories[j].items[k]);
            }
        }
    }
    return websiteMenuItems;
}

export function syncOrderData(orderItems: any, websiteOnlineOrderingInfo: any): void {
    // console.warn("Synchronize order data to avoid abuse");
    // console.warn("orderItems", JSON.stringify(orderItems));
    const websiteMenuItems = processMenuData(websiteOnlineOrderingInfo);
    // console.warn("websiteMenuItems", JSON.stringify(websiteMenuItems));
    for (let item of orderItems) {
        let foundMenuItem = false;
        for (let menuItem of websiteMenuItems) {
            if (item.uniqueId === menuItem.uniqueId) {
                foundMenuItem = true;
                item["header"] = menuItem.header;
                item.title = menuItem.title;
                item.price = menuItem.price;
                item.priceIonic = menuItem.priceIonic;
                item.taxes = menuItem.taxes;
                for (let itemOptionGroup of item.optionGroups) {
                    let foundMenuItemOptionGroup = false;
                    for (let menuItemOptionGroup of menuItem.optionGroups) {
                        if (itemOptionGroup.uniqueId === menuItemOptionGroup.uniqueId) {
                            foundMenuItemOptionGroup = true;
                            for (let itemOptionGroupOption of itemOptionGroup.options) {
                                let foundMenuItemOptionGroupOption = false;
                                for (let menuItemOptionGroupOption of menuItemOptionGroup.options) {
                                    if (itemOptionGroupOption.uniqueId === menuItemOptionGroupOption.uniqueId) {
                                        foundMenuItemOptionGroupOption = true;
                                        itemOptionGroupOption.price = menuItemOptionGroupOption.price;
                                        itemOptionGroupOption.priceIonic = menuItemOptionGroupOption.priceIonic;
                                        break;
                                    }
                                }
                                if (!foundMenuItemOptionGroupOption) {
                                    console.error("MENU_ITEM_OPTION_GROUP_OPTION_NOT_FOUND", JSON.stringify(itemOptionGroupOption), JSON.stringify(menuItemOptionGroup));
                                    // INFO - This allows unknown Option Groups options by frontend abuser
                                }
                            }
                            break;
                        }
                    }
                    if (!foundMenuItemOptionGroup) {
                        console.error("MENU_ITEM_OPTION_GROUP_NOT_FOUND", JSON.stringify(item.optionGroups), JSON.stringify(menuItem.optionGroups));
                        // INFO - This allows unknown Option Groups options by frontend abuser
                    }
                }
                break;
            }
        }
        if (!foundMenuItem) {
            console.error("MENU_ITEM_OPTION_GROUP_NOT_FOUND", JSON.stringify(item));
            // INFO - This allows unknown Option Groups options by frontend abuser
        }
    }
}

/*
* Calculate order total functions
*/
function calculateAddOnsPrice(menuItem: any) {
    let addOnsPrice: number = 0;
    for (let optionGroup of menuItem.optionGroups)
        if (optionGroup.type === appConstants.ONLINE_ORDERING_OPTIONS_GROUP_TYPE_SINGLE_SELECT || optionGroup.type === appConstants.ONLINE_ORDERING_OPTIONS_GROUP_TYPE_MULTI_SELECT) {
            for (let option of optionGroup.options) {
                if (!option.isHide && option.valueIonic.value) {
                    addOnsPrice += option.priceIonic.value;
                }
            }
        } else if (optionGroup.type === appConstants.ONLINE_ORDERING_OPTIONS_GROUP_TYPE_COUNTABLES) {
            for (let option of optionGroup.options) {
                if (!option.isHide) {
                    addOnsPrice += option.priceIonic.value * (option.valueIonic.value as number);
                }
            }
        }
    menuItem["addOnsPrice"] = addOnsPrice;
}
function getItemTotalPrice(item: any): number {
    calculateAddOnsPrice(item);
    return (item.priceIonic.value + item.addOnsPrice + (item.miscNote ? Number(item.miscNote?.price) : 0)) * item.quantity;
}
function getCartSubtotalAmount(orderItems: any[]): number {
    let subtotalAmount: number = 0;
    for (let item of orderItems) {
        subtotalAmount += getItemTotalPrice(item);
    }
    return subtotalAmount;
}
function getCartTaxesTotalAmount(orderItems: any[]): number {
    let totalTaxes: number = 0;
    for (let item of orderItems) {
        for (let tax of item.taxes) {
            totalTaxes += getItemTotalPrice(item) * (Number(tax.percentage) / 100);
        }
    }
    return totalTaxes;
}
function getCartTotal(orderSubtotal: number, orderTaxes: number, miscNote: WebsiteDataContentPricingItemMiscNote | null, orderHandlingFee: number, orderType: string, orderDeliveryFee: number, orderRewardDollarsRedeemed: number): number {
    return orderSubtotal + orderTaxes + (miscNote ? Number(miscNote.price) : 0) + orderHandlingFee + (orderType === appConstants.ONLINE_ORDER_TYPE_DELIVERY ? orderDeliveryFee : 0) - orderRewardDollarsRedeemed;
}
export function calcOrderTotal(orderItems: any[], miscNote: WebsiteDataContentPricingItemMiscNote | null, orderHandlingFee: number, orderType: string, orderDeliveryFee: number, orderRewardDollarsRedeemed: number): number {
    const orderSubtotal = getCartSubtotalAmount(orderItems);
    const orderTaxes = getCartTaxesTotalAmount(orderItems);
    return getCartTotal(orderSubtotal, orderTaxes, miscNote, orderHandlingFee, orderType, orderDeliveryFee, orderRewardDollarsRedeemed);
}

export function normalizePhoneNumber(phoneNumber: string): string {
    // Remove any non-numeric characters, but allow for the leading "+".
    let cleanedNumber = phoneNumber.replace(/[^\d+]/g, '');

    // If the number starts with "+1", remove the "+" and keep the digits.
    if (cleanedNumber.startsWith('+1')) {
        cleanedNumber = cleanedNumber.slice(2);
    }

    // If the number starts with "1", remove the "1" and add the "+" back.
    if (cleanedNumber.startsWith('1')) {
        cleanedNumber = cleanedNumber.slice(1);
    }

    // Ensure the number starts with "+1" and has exactly 10 digits.
    if (cleanedNumber.length === 10) {
        return '+1' + cleanedNumber;
    }

    // If the cleaned number doesn't have exactly 10 digits, throw an error.
    throw "Invalid phone number. It must have 10 digits.";
}

export function isOnlineOrderingAvailable(timezone: any, startTimes: any, endTimes: any): boolean {
    try {
        const now = moment(); // Current time in UTC
        const localTime = now.tz(timezone); // Convert UTC time to user's timezone

        // Get current day and time in user's timezone
        const currentDay = localTime.format('ddd'); // "Mon", "Tue", etc.
        const currentTimeHHMM = localTime.format('HH:mm'); // "14:30"

        // Business hours for the day
        const startTime = startTimes[currentDay];
        const endTime = endTimes[currentDay];

        if (!startTime || !endTime) {
            throw new Error("Invalid business hours data");
        }

        // Parse business hours into the correct timezone
        const todayDate = localTime.format('YYYY-MM-DD'); // Example: "2025-03-10"
        const startDateTime = moment.tz(`${todayDate} ${startTime}`, 'YYYY-MM-DD HH:mm', timezone);
        const endDateTime = moment.tz(`${todayDate} ${endTime}`, 'YYYY-MM-DD HH:mm', timezone);
        const currentDateTime = moment.tz(`${todayDate} ${currentTimeHHMM}`, 'YYYY-MM-DD HH:mm', timezone);

        return currentDateTime.isBetween(startDateTime, endDateTime, null, '[]'); // Check if current time is within business hours
    } catch (error) {
        console.error("Error processing request:", error);
        return true;
    }
}

export function getUtcTimestamp(dateString: any, time: string = 'start'): number {
    const [year, month, day] = dateString.split('-').map(Number);

    if (time === 'end') {
        return Date.UTC(year, month - 1, day, 23, 59, 59, 999);
    }

    return Date.UTC(year, month - 1, day, 0, 0, 0, 0);
}

export function formatDateFromTimestamp(timestamp: any, timezone: any): string {
    try {
        const localTime = moment.tz(timestamp, timezone); // Convert timestamp to local time
        return localTime.format('DD-MM-YYYY'); // Format as "DD-MM-YYYY"
    } catch (error) {
        console.error("Error processing date:", error);
        throw error;
    }
}

export function getLocalizedDate(utcTimestamp: any, timezone: any): string {
    const localTime = moment.tz(utcTimestamp, 'UTC').tz(timezone);
    const dateStrArr = localTime.format().split("T")[0].split("-");
    return `${dateStrArr[2]}/${dateStrArr[1]}/${dateStrArr[0]}`;
}

export function getLocalizedTimestamp(utcTimestamp: any, timezone: any): number {
    const localTime = moment.tz(utcTimestamp, 'UTC').tz(timezone);
    return Number(localTime.valueOf());
}

export function getDaysBetweenTimestamps(startTimestamp: any, endTimestamp: any): number {
    const millisecondsPerDay = 24 * 60 * 60 * 1000; // 1 day in milliseconds
    const differenceInMilliseconds = Math.abs(endTimestamp - startTimestamp);
    return Math.ceil(differenceInMilliseconds / millisecondsPerDay); // Always round up
}

export function getPaymentLink(businessLocale: any): string {
    let paymentLink;
    switch (businessLocale) {
        case appConstants.BUSINESS_LOCALE_CA:
            paymentLink = appConstants.PAYPAL_PAYMENT_LINK_CA;
            break;
        case appConstants.BUSINESS_LOCALE_US:
            paymentLink = appConstants.PAYPAL_PAYMENT_LINK_US;
            break;
        default:
            paymentLink = appConstants.PAYPAL_PAYMENT_LINK_US;
            break;
    }
    return paymentLink;
}

export function getWebsiteCurrency(businessLocale: any): string {
    let currency;
    switch (businessLocale) {
        case appConstants.BUSINESS_LOCALE_CA:
            currency = appConstants.CURRENCY_CAD;
            break;
        case appConstants.BUSINESS_LOCALE_US:
            currency = appConstants.CURRENCY_USD;
            break;
        default:
            currency = appConstants.CURRENCY_USD;
            break;
    }
    return currency;
}

export function formatAmountForStripe(amount: string | number): number {
    return Math.round(Number(amount) * 100);
}

/*
* Decode JWT token
*/
export function decodeJwtToken(token: string): any {
    return jwtDecode(token);
}

/*
* Encode to base64
*/
export function encodeBase64(data: any): string {
    return Buffer.from(data).toString('base64');
}

/*
* Decode base64
*/
export function decodeBase64(base64Str: string): string {
    return Buffer.from(base64Str, 'base64').toString('ascii');
}

/*
* Checks whether user is admin
*/
export function isUserAdminByDecodedToken(decodedToken: any) {
    if (decodedToken) {
        if (decodedToken["cognito:groups"]) {
            const cognitoGroups = decodedToken["cognito:groups"];
            for (let cognitoGroupName of cognitoGroups) {
                if (cognitoGroupName.valueOf() === appConstants.COGNITO_GROUP_ADMINS) {
                    return true;
                }
            }
            return false;
        } else {
            return false;
        }
    } else {
        return false;
    }
}

/*
* Session DB attributes to SessionData
*/
export function sessionDBAttributesToSessionData(sessionAttributes: any): SessionData {
    const sessionData: SessionData = {} as SessionData;
    sessionData.sessionId = sessionAttributes["pk"].split('#')[1];
    sessionData.sessionIsUserAdmin = sessionAttributes["sessionUserIsAdmin"];
    sessionData.sessionRememberMe = sessionAttributes["sessionRememberMe"];
    sessionData.sessionUserName = sessionAttributes["sessionUserName"];
    sessionData.sessionUserAvatarUri = sessionAttributes["sessionUserAvatarUri"];
    sessionData.sessionCreatedAt = sessionAttributes["sessionCreatedAt"];
    sessionData.sessionExpiryDate = sessionAttributes["ttl"];
    return sessionData;
}

/*
* Attach cookie to response
*/
export function attachCookie(res:  any, sessionId: string, rememberMe: boolean): void {
    res.cookie(`SessionData`,{SessionId: sessionId, RememberMe: rememberMe},{
        maxAge: rememberMe ? appConstants.COOKIE_TIMEOUT_MILLIS_YEAR : appConstants.COOKIE_TIMEOUT_MILLIS,
        secure: !IN_DEV,
        httpOnly: appConstants.COOKIE_HTTP_ONLY,
        sameSite: appConstants.COOKIE_SAME_SITE,
    });
}

/*
* Ensure image type is valid
*/
export function validateImageType(imageType: string): string | null {
    if (
        imageType.valueOf() === 'png' ||
        imageType.valueOf() === 'jpg' ||
        imageType.valueOf() === 'jpeg'
    ) {
        if (imageType.valueOf() === 'jpg') {
            return 'jpeg';
        }
        return imageType;
    } else {
        return null;
    }
}


/*
* S3 uri to url
*/
export function uriToUrl(bucketOrigin: string, uri: string, withTimeStamp: boolean = true) {
    let url = `${bucketOrigin}${uri}`;
    if (withTimeStamp) {
        const timestamp = Date.now();
        url += `?timestamp=${timestamp}`;
    }
    return url;
}

/*
* Register interval timer
*/
export function registerTimer(intervalInMs: number, fn: () => void | Promise<void>): ReturnType<typeof setInterval> {
    if (intervalInMs <= 0) {
        throw new Error('Interval must be greater than 0ms');
    }

    if (intervalInMs <= 0) {
        throw new Error('Interval must be greater than 0ms');
    }

    // Run immediately
    (async () => {
        try {
            await fn();
        } catch (err) {
            console.error(`Error in registerTimer immediate execution:`, err);
        }
    })();

    // Continue running at intervals
    return setInterval(async () => {
        try {
            await fn();
        } catch (err) {
            console.error(`Error in registerTimer interval execution:`, err);
        }
    }, intervalInMs);

}