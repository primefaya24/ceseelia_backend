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
  StoreItem,
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

export async function updateStoreCategory(
  storeId: string,
  categoryId: string,
  storeCategory: StoreCategory
): Promise<string> {
  try {
    const command = new UpdateCommand({
      TableName: DEFAULT_TABLE_NAME,
      Key: {
        pk: appConstants.DYNAMO_ENTITY_STORE + "#" + storeId,
        sk: appConstants.DYNAMO_ENTITY_CATEGORY + "#" + categoryId,
      },
      UpdateExpression:
        "SET storeCategoriyId = :storeCategoriyId, storeCategoryName = :storeCategoryName, storeCategoryDescription = :storeCategoryDescription, storeCategoryBannerUri = :storeCategoryBannerUri, storeCategoryIsActive = :storeCategoryIsActive, storeCategoryDiscountPercent = :storeCategoryDiscountPercent, storeCategoryItemCount = :storeCategoryItemCount",
      ExpressionAttributeValues: {
        ":storeCategoriyId": categoryId,
        ":storeCategoryName": storeCategory.storeCategoryName,
        ":storeCategoryDescription": storeCategory.storeCategoryDescription,
        ":storeCategoryBannerUri": storeCategory.storeCategoryBannerUri,
        ":storeCategoryIsActive": storeCategory.storeCategoryIsActive,
        ":storeCategoryDiscountPercent":
          storeCategory.storeCategoryDiscountPercent,
        ":storeCategoryItemCount": 0,
      },
    });
    await dynamoDbDocumentClient.send(command);
    return categoryId;
  } catch (e) {
    console.error("In updateStoreCategory", e);
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
  storeId: string
): Promise<StoreInventoryData> {
  try {
    const storePk = appConstants.DYNAMO_ENTITY_STORE + "#" + storeId;
    const categoriesCommand = new QueryCommand({
      TableName: DEFAULT_TABLE_NAME,
      KeyConditionExpression: "#pk = :pk and begins_with(#sk, :sk_prefix)",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": storePk,
        ":sk_prefix": appConstants.DYNAMO_ENTITY_CATEGORY + "#",
      },
    });
    const parametersCommand = new QueryCommand({
      TableName: DEFAULT_TABLE_NAME,
      KeyConditionExpression: "#pk = :pk and begins_with(#sk, :sk_prefix)",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": storePk,
        ":sk_prefix": appConstants.DYNAMO_ENTITY_PARAMETER + "#",
      },
    });
    const itemsCommand = new QueryCommand({
      TableName: DEFAULT_TABLE_NAME,
      KeyConditionExpression: "#pk = :pk and begins_with(#sk, :sk_prefix)",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": storePk,
        ":sk_prefix": "ITEM#",
      },
    });
    const settingsCommand = new GetCommand({
      TableName: DEFAULT_TABLE_NAME,
      Key: {
        pk: storePk,
        sk: appConstants.DYNAMO_ENTITY_SETTINGS,
      },
    });

    const [categoriesResult, parametersResult, itemsResult, settingsResult] =
      await Promise.all([
        dynamoDbDocumentClient.send(categoriesCommand),
        dynamoDbDocumentClient.send(parametersCommand),
        dynamoDbDocumentClient.send(itemsCommand),
        dynamoDbDocumentClient.send(settingsCommand),
      ]);

    const categories: StoreCategory[] = (categoriesResult.Items ?? []).map(
      (record) => {
        const { pk: _pk, sk: _sk, ...rest } = record;
        return rest as StoreCategory;
      }
    );
    const parameters: StoreParameter[] = (parametersResult.Items ?? []).map(
      (record) => {
        const { pk: _pk, sk: _sk, ...rest } = record;
        return rest as StoreParameter;
      }
    );
    const items: StoreItem[] = (itemsResult.Items ?? []).map((record) => {
      const { pk: _pk, sk: _sk, ...rest } = record;
      return rest as StoreItem;
    });
    let settings: StoreSettings = initStoreSettings();
    if (settingsResult.Item) {
      const { pk: _pk, sk: _sk, ...rest } = settingsResult.Item;
      settings = rest as StoreSettings;
    }

    return {
      categories,
      parameters,
      items,
      settings,
    };
  } catch (e) {
    console.error("In getStoreInventoryData", e);
    throw e;
  }
}
