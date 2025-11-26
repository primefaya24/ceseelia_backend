import { google, androidmanagement_v1 } from "googleapis";
import {getAndroidEnterpriseServiceAccount} from "../../aws/s3";

const enterpriseId: string = "LC015yuwbm";

/**
 * Get Android Management Controller (Google API Client)
 */
async function getAndroidManagementController(): Promise<androidmanagement_v1.Androidmanagement> {
    try {
        const credentials = await getAndroidEnterpriseServiceAccount();
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/androidmanagement']
        });

        return google.androidmanagement({
            version: 'v1',
            auth
        });
    } catch (e) {
        console.error("In getAndroidManagementController", e);
        throw e;
    }
}

/**
 * List Android Management Policies
 */
export async function listPolicies(): Promise<androidmanagement_v1.Schema$Policy[]> {
    try {
        const androidManagementController = await getAndroidManagementController();
        let policies: androidmanagement_v1.Schema$Policy[] = [];
        let nextPageToken: string | undefined;

        do {
            const res = await androidManagementController.enterprises.policies.list({
                parent: `enterprises/${enterpriseId}`,
                pageSize: 100,
                pageToken: nextPageToken
            });

            policies = policies.concat(res.data.policies ?? []);
            nextPageToken = res.data.nextPageToken ?? undefined;
        } while (nextPageToken);

        return policies.reverse();
    } catch (e) {
        console.error("In listPolicies", e);
        throw e;
    }
}

/**
 * Delete a Policy by name
 */
export async function deletePolicy(policyName: string): Promise<androidmanagement_v1.Schema$Empty | undefined> {
    try {
        const androidManagementController = await getAndroidManagementController();
        const res = await androidManagementController.enterprises.policies.delete({
            name: `enterprises/${enterpriseId}/policies/${policyName}`
        });
        return res.data;
    } catch (e) {
        console.error("In deletePolicy", e);
        throw e;
    }
}

/**
 * Update a Policy
 */
export async function updatePolicy(
    policyName: string,
    policy: androidmanagement_v1.Schema$Policy
): Promise<androidmanagement_v1.Schema$Policy | undefined> {
    try {
        const androidManagementController = await getAndroidManagementController();
        const res = await androidManagementController.enterprises.policies.patch({
            name: `enterprises/${enterpriseId}/policies/${policyName}`,
            requestBody: policy
        });
        return res.data;
    } catch (e) {
        console.error("In updatePolicy", e);
        throw e;
    }
}

/**
 * Generate Enrollment QR Code
 */
export async function generateEnrollmentQRCode(policyName: string): Promise<string | undefined> {
    try {
        const androidManagementController = await getAndroidManagementController();
        const res = await androidManagementController.enterprises.enrollmentTokens.create({
            parent: `enterprises/${enterpriseId}`,
            requestBody: {
                policyName,
                expirationTimestamp: new Date(Date.now() + 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
            }
        });
        return res.data.qrCode ?? undefined;
    } catch (e) {
        console.error("In generateEnrollmentQRCode", e);
        throw e;
    }
}

/**
 * List Android Devices
 */
export async function listDevices(): Promise<androidmanagement_v1.Schema$Device[]> {
    try {
        const androidManagementController = await getAndroidManagementController();
        let devices: androidmanagement_v1.Schema$Device[] = [];
        let nextPageToken: string | undefined;

        do {
            const res = await androidManagementController.enterprises.devices.list({
                parent: `enterprises/${enterpriseId}`,
                pageSize: 100,
                pageToken: nextPageToken
            });

            devices = devices.concat(res.data.devices ?? []);
            nextPageToken = res.data.nextPageToken ?? undefined;
        } while (nextPageToken);

        return devices.reverse();
    } catch (e) {
        console.error("In listDevices", e);
        throw e;
    }
}

/**
 * Delete Device by ID
 */
export async function deleteDevice(deviceId: string): Promise<androidmanagement_v1.Schema$Empty | undefined> {
    try {
        const androidManagementController = await getAndroidManagementController();
        const res = await androidManagementController.enterprises.devices.delete({
            name: `enterprises/${enterpriseId}/devices/${deviceId}`
        });
        return res.data;
    } catch (e) {
        console.error("In deleteDevice", e);
        throw e;
    }
}

/**
 * Update a Device's Policy
 */
export async function updateDevicePolicy(
    deviceId: string,
    policyName: string
): Promise<androidmanagement_v1.Schema$Device | undefined> {
    try {
        const androidManagementController = await getAndroidManagementController();
        const res = await androidManagementController.enterprises.devices.patch({
            name: `enterprises/${enterpriseId}/devices/${deviceId}`,
            updateMask: 'policyName',
            requestBody: {
                policyName: `enterprises/${enterpriseId}/policies/${policyName}`
            }
        });
        return res.data;
    } catch (e) {
        console.error("In updateDevicePolicy", e);
        throw e;
    }
}
