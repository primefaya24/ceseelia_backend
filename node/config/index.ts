// Imports
import dotenv from 'dotenv';
dotenv.config();
import {appConstants} from '../constants';

/*
* Environment
*/
export const localServerIp: string = "0.0.0.0"; // localhost
export const STAGE: string = appConstants.STAGE_DEV;
export const PORT: number = 3100;
export const IN_DEV: boolean = STAGE.valueOf() === appConstants.STAGE_DEV;
export const ORIGIN: string = `http://${localServerIp}:4200`;

/*
* DynamoDB
*/
export const DB_TABLE_NAME: string = `${appConstants.DYNAMO_TABLE_PREFIX}${STAGE}`;
export const DB_TABLE_PRIME_DINE_NAME: string = `${appConstants.DYNAMO_TABLE_PRIME_DINE_PREFIX}${STAGE}`;

/*
* Cognito
*/
export const COGNITO_USER_POOL_ID: string = IN_DEV ? "us-east-1_fxms3lOFG" : "us-east-1_Wbghzv4O6";
export const COGNITO_USER_POOL_CLIENT_ID: string = IN_DEV ? "77leupl6s9fq62d4bdhnncd1sa" : "7spb46bjfte8ehci2d2nbnplue";
export const COGNITO_USER_POOL_CLIENT_SECRET: string = IN_DEV ? "" : "";
export const COGNITO_AUTH_DOMAIN: string = `https://${STAGE}.auth.awsfire.com/oauth2/token`;
export const COGNITO_FEDERATION_REDIRECT_URL: string = IN_DEV ? "http://localhost:3100/" : "https://awsfire.com/";

/*
* S3
*/
export const S3_STORAGE_BUCKET_NAME: string = `${appConstants.S3_STORAGE_BUCKET_PREFIX}${STAGE}`;
export const S3_STORAGE_BUCKET_ORIGIN: string = `https://${STAGE}.storage.awsfire.com/`;

export const S3_ASSETS_BUCKET_NAME: string = `aws-fire-assets`;
export const S3_ASSETS_BUCKET_ORIGIN: string = `https://assets.awsfire.com/`;

/*
* ServerWatch
*/
export const SERVER_WATCH_CHECK_FOR_LOST_ORDERS_INTERVAL: number = IN_DEV ? 10 * 60 * 1000 : 10 * 60 * 1000;

