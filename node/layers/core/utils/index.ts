import https from "https";
import zlib from "zlib";
import moment from "moment-timezone";
import { AppBoolean, AppNumber } from "../interfaces/elements";
import { appConstants } from "../../../constants";
import { IN_DEV, S3_STORAGE_BUCKET_NAME, STAGE } from "../../../config";
import { jwtDecode } from "jwt-decode";
import { deleteS3Keys, listPrefixFiles } from "../../aws/s3";
import { StoreSettings } from "../interfaces/store";

/*
 * Send Https request with given body and options
 */
export function sendHttpsRequest(options: any, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      res.setEncoding("utf8");
      let responseBody = "";

      res.on("data", (chunk) => {
        responseBody += chunk;
      });

      res.on("end", () => {
        resolve(JSON.parse(responseBody));
      });
    });

    req.on("error", (err) => {
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
  return !IN_DEV
    ? `https://${baseDomain}/${key}`
    : `https://${STAGE}.${baseDomain}/${key}`;
}

/*
 * Turn dynamodb items into primary key only items
 */
export function getItemsPrimaryKeys(items: any) {
  for (let i = 0; i < items.length; i++) {
    items[i] = {
      pk: items[i].pk,
      sk: items[i].sk,
    };
  }
  return items;
}

/*
 * Validate image type
 */
export function validateAssetType(imgType: any) {
  if (imgType !== "png" && imgType !== "jpg" && imgType !== "jpeg") {
    throw "Invalid image type";
  }
  if (imgType !== "jpg") {
    return "jpeg";
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
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
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
      units: "B",
    };
  } else if (1024 <= bytes && bytes < 1048576) {
    // 1 KB <= x < 1 MB
    return {
      size: (bytes / 1024).toFixed(2),
      units: "KB",
    };
  } else if (1048576 <= bytes && bytes < 1073741824) {
    // 1 MB <= x < 1 GB
    return {
      size: (bytes / 1048576).toFixed(2),
      units: "MB",
    };
  }
  return {
    size: "",
    units: "-",
  };
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
      str.charAt(i) !== "." && // Dot
      str.charAt(i) !== "_" // Underscore
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
    serviceHandle.length > 0 && isAlphaNumericWithDotOrUnderscore(serviceHandle)
  );
}

/*
 * Get Lat/Lng timezone data
 */
export async function getLatLngTimezoneData(
  lat: any,
  lng: any,
  epochSeconds: any
): Promise<any> {
  try {
    return await sendHttpsRequest(
      {
        host: "maps.googleapis.com",
        path: `/maps/api/timezone/json?location=${lat},${lng}&timestamp=${epochSeconds}&key=AIzaSyClD9NQPlpNtXro0MvR69NseYEHlqaYAIo`,
        method: "GET",
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
  const [time, modifier] = time12h.split(" ");

  let [hours, minutes] = time.split(":");

  if (hours === "12") {
    hours = "00";
  }

  if (modifier === "PM") {
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
  var ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  hours = hours ? hours : 12; // the hour '0' should be '12'
  minutes = minutes < 10 ? "0" + minutes : minutes;
  var strTime = hours + ":" + minutes + " " + ampm;
  return strTime;
}

/*
 * Is user member
 */
export function isUserWebsiteAdmin(websiteMembershipDoc: any): boolean {
  return (
    websiteMembershipDoc["websiteMemberPermission"] ===
      appConstants.USER_PERMISSION_ADMIN &&
    websiteMembershipDoc["websiteMemberStatus"] ===
      appConstants.DYNAMO_ENTITY_APPROVED
  );
}
export function isUserWebsiteModerator(websiteMembershipDoc: any): boolean {
  return (
    websiteMembershipDoc["websiteMemberPermission"] ===
      appConstants.USER_PERMISSION_MODERATOR &&
    websiteMembershipDoc["websiteMemberStatus"] ===
      appConstants.DYNAMO_ENTITY_APPROVED
  );
}

export function isNumeric(n: unknown): boolean {
  return !isNaN(parseFloat(String(n))) && isFinite(Number(n));
}

export function normalizePhoneNumber(phoneNumber: string): string {
  // Remove any non-numeric characters, but allow for the leading "+".
  let cleanedNumber = phoneNumber.replace(/[^\d+]/g, "");

  // If the number starts with "+1", remove the "+" and keep the digits.
  if (cleanedNumber.startsWith("+1")) {
    cleanedNumber = cleanedNumber.slice(2);
  }

  // If the number starts with "1", remove the "1" and add the "+" back.
  if (cleanedNumber.startsWith("1")) {
    cleanedNumber = cleanedNumber.slice(1);
  }

  // Ensure the number starts with "+1" and has exactly 10 digits.
  if (cleanedNumber.length === 10) {
    return "+1" + cleanedNumber;
  }

  // If the cleaned number doesn't have exactly 10 digits, throw an error.
  throw "Invalid phone number. It must have 10 digits.";
}

export function getUtcTimestamp(
  dateString: any,
  time: string = "start"
): number {
  const [year, month, day] = dateString.split("-").map(Number);

  if (time === "end") {
    return Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  }

  return Date.UTC(year, month - 1, day, 0, 0, 0, 0);
}

export function formatDateFromTimestamp(timestamp: any, timezone: any): string {
  try {
    const localTime = moment.tz(timestamp, timezone); // Convert timestamp to local time
    return localTime.format("DD-MM-YYYY"); // Format as "DD-MM-YYYY"
  } catch (error) {
    console.error("Error processing date:", error);
    throw error;
  }
}

export function getLocalizedDate(utcTimestamp: any, timezone: any): string {
  const localTime = moment.tz(utcTimestamp, "UTC").tz(timezone);
  const dateStrArr = localTime.format().split("T")[0].split("-");
  return `${dateStrArr[2]}/${dateStrArr[1]}/${dateStrArr[0]}`;
}

export function getLocalizedTimestamp(
  utcTimestamp: any,
  timezone: any
): number {
  const localTime = moment.tz(utcTimestamp, "UTC").tz(timezone);
  return Number(localTime.valueOf());
}

export function getDaysBetweenTimestamps(
  startTimestamp: any,
  endTimestamp: any
): number {
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
  return Buffer.from(data).toString("base64");
}

/*
 * Decode base64
 */
export function decodeBase64(base64Str: string): string {
  return Buffer.from(base64Str, "base64").toString("ascii");
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
 * Attach cookie to response
 */
export function attachCookie(
  res: any,
  sessionId: string,
  rememberMe: boolean
): void {
  res.cookie(
    `SessionData`,
    { SessionId: sessionId, RememberMe: rememberMe },
    {
      maxAge: rememberMe
        ? appConstants.COOKIE_TIMEOUT_MILLIS_YEAR
        : appConstants.COOKIE_TIMEOUT_MILLIS,
      secure: !IN_DEV,
      httpOnly: appConstants.COOKIE_HTTP_ONLY,
      sameSite: appConstants.COOKIE_SAME_SITE,
    }
  );
}

/*
 * Ensure image type is valid
 */
export function validateImageType(imageType: string): string | null {
  if (
    imageType.valueOf() === "png" ||
    imageType.valueOf() === "jpg" ||
    imageType.valueOf() === "jpeg"
  ) {
    if (imageType.valueOf() === "jpg") {
      return "jpeg";
    }
    return imageType;
  } else {
    return null;
  }
}

/*
 * Covvert Uri to Url
 */
export function getStorageImageUrl(imageUri: string) {
  return `https://dev.storage.ceseelia.com/${imageUri}`;
}

/*
 * S3 uri to url
 */
export function uriToUrl(
  bucketOrigin: string,
  uri: string,
  withTimeStamp: boolean = true
) {
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
export function registerTimer(
  intervalInMs: number,
  fn: () => void | Promise<void>
): ReturnType<typeof setInterval> {
  if (intervalInMs <= 0) {
    throw new Error("Interval must be greater than 0ms");
  }

  if (intervalInMs <= 0) {
    throw new Error("Interval must be greater than 0ms");
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

export function formatEpochToFullReadableDate(
  epochMillis: number,
  hideCurrentYear: boolean = false
): string {
  if (!epochMillis) return appConstants.NA;

  const date = new Date(epochMillis);

  const isCurrentYear = date.getFullYear() === new Date().getFullYear();

  const datePart = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    // omit year if flag is on AND date is within current year
    year: hideCurrentYear && isCurrentYear ? undefined : "numeric",
  });

  const timePart = date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return `${datePart} (${timePart})`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function cleanUpS3Folder(
  folderUri: string,
  keepImageUris: string[]
) {
  try {
    const currentS3Uris: string[] = (
      await listPrefixFiles(S3_STORAGE_BUCKET_NAME, folderUri)
    )
      .map((o) => o.Key)
      .filter((key): key is string => typeof key === "string");

    const imageInputUris = Array.isArray(keepImageUris)
      ? new Set(
          keepImageUris.filter(
            (uri: unknown): uri is string =>
              typeof uri === "string" && uri.trim().length > 0
          )
        )
      : new Set<string>();
    const keysToDelete: string[] = currentS3Uris.filter(
      (key) => !imageInputUris.has(key)
    );

    if (keysToDelete.length > 0) {
      await deleteS3Keys(S3_STORAGE_BUCKET_NAME, keysToDelete);
    }
  } catch (e) {
    console.error("In cleanUpS3Folder", e);
  }
}

export function extractStorePromoImageUris(
  storeSettings: StoreSettings
): string[] {
  const promoUris: string[] = [];
  switch (storeSettings.templateId) {
    case appConstants.STORE_TEMPLATE_DEFAULT:
      for (let promoImage of storeSettings.customize.promoContent.promoImages) {
        if (promoImage.imageUri && promoImage.imageUri.length > 0) {
          promoUris.push(promoImage.imageUri);
        }
      }
      break;
    default:
      break;
  }
  return promoUris;
}
