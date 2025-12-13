// Imports
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import * as ULID from "ulid";
import { appConstants } from "../../../../../constants";
import { dynamoWriteManyItems } from "../../dynamo-batch-ops";
import { DB_TABLE_NAME } from "../../../../../config";
import {
  initStore,
  initStoreSettings,
  StoreCategory,
  StoreInventoryData,
  StoreOverview,
  StoreParameter,
  StoreSettings,
} from "../../../../core/interfaces/store";

// Initialize DynamoDB Document Client
const dynamoDbDocumentClient: DynamoDBDocumentClient =
  DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: appConstants.DEFAULT_REGION,
    })
  );

// Constants
const DEFAULT_TABLE_NAME: string | undefined = DB_TABLE_NAME;

export async function createStore(
  storeName: string,
  storeSlug: string
): Promise<StoreOverview> {
  try {
    const storeId: string = ULID.ulid();
    const storeOverview: StoreOverview = initStore(
      storeId,
      storeName,
      storeSlug
    );
    const storeSettings: StoreSettings = initStoreSettings();
    await dynamoWriteManyItems(DEFAULT_TABLE_NAME, [
      // Store overview
      {
        PutRequest: {
          Item: {
            pk: appConstants.DYNAMO_ENTITY_APP_STORE,
            sk:
              appConstants.DYNAMO_ENTITY_STORE +
              "#" +
              storeId +
              "#" +
              appConstants.DYNAMO_ENTITY_OVERVIEW,
            ...storeOverview,
          },
        },
      },
      // Store settings
      {
        PutRequest: {
          Item: {
            pk: appConstants.DYNAMO_ENTITY_STORE + "#" + storeId,
            sk: appConstants.DYNAMO_ENTITY_SETTINGS,
            ...storeSettings,
          },
        },
      },
    ]);
    return storeOverview;
  } catch (e) {
    console.error("In createStore", e);
    throw e;
  }
}

export async function createStoreCategory(
  storeId: string,
  storeCategory: StoreCategory
): Promise<string> {
  try {
    const categoryId: string = ULID.ulid();
    const command = new PutCommand({
      TableName: DEFAULT_TABLE_NAME,
      Item: {
        pk: appConstants.DYNAMO_ENTITY_STORE + "#" + storeId,
        sk: appConstants.DYNAMO_ENTITY_CATEGORY + "#" + categoryId,
        storeCategoriyId: categoryId,
        storeCategoryName: storeCategory.storeCategoryName,
        storeCategoryDescription: storeCategory.storeCategoryDescription,
        storeCategoryBannerUri: storeCategory.storeCategoryBannerUri,
        storeCategoryIsActive: storeCategory.storeCategoryIsActive,
        storeCategoryDiscountPercent:
          storeCategory.storeCategoryDiscountPercent,
        storeCategoryItemCount: 0,
      },
    });
    await dynamoDbDocumentClient.send(command);
    return categoryId;
  } catch (e) {
    console.error("In createStoreCategory", e);
    throw e;
  }
}

export async function createStoreParameter(
  storeId: string,
  storeParameter: StoreParameter
): Promise<string> {
  try {
    const parameterId: string = ULID.ulid();
    const command = new PutCommand({
      TableName: DEFAULT_TABLE_NAME,
      Item: {
        pk: appConstants.DYNAMO_ENTITY_STORE + "#" + storeId,
        sk: appConstants.DYNAMO_ENTITY_PARAMETER + "#" + parameterId,
        storeParamId: parameterId,
        storeParamLabel: storeParameter.storeParamLabel,
        storeParamType: storeParameter.storeParamType,
        storeParamIsMandatory: storeParameter.storeParamIsMandatory,
        storeParamOptions: storeParameter.storeParamOptions,
      },
    });
    await dynamoDbDocumentClient.send(command);
    return parameterId;
  } catch (e) {
    console.error("In createStoreParameter", e);
    throw e;
  }
}

export async function getStoreInventoryData(
  storeId: string,
): Promise<StoreInventoryData> {
  try {
    // TODO
    return {} as StoreInventoryData;
  } catch (e) {
    console.error("In getStoreInventoryData", e);
    throw e;
  }
}