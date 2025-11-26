export interface TimezoneData {
    dstOffset: number;
    rawOffset: number;
    status: string;
    timeZoneId: string;
    timeZoneName: string;
}

export interface LocationData {
    "address": string;
    "city": {
        "name": string;
        "shortName": string;
    },
    "country": {
        "name": string;
        "shortName": string;
    },
    "latLng": {
        "latitude": number;
        "longitude": number;
    },
    "locality": string;
    "placeId": string;
}

export type Weekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

export interface SQSMessageItem {
    topicId: string;
    data: any;
}

export interface AppString {
    value: string;
}

export interface AppNumber {
    value: number;
}

export interface AppBoolean {
    value: boolean;
}