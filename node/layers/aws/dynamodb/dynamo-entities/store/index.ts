// Imports
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
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
import { getStorageImageUrl } from "../../../../core/utils";

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

export async function updateStoreItem(
  storeId: string,
  storeItem: StoreItem,
  storeItemId: string | undefined
): Promise<string> {
  try {
    const itemId: string =
      storeItemId && storeItemId.length > 0 ? storeItemId : ULID.ulid();
    const command = new UpdateCommand({
      TableName: DEFAULT_TABLE_NAME,
      Key: {
        pk: appConstants.DYNAMO_ENTITY_STORE + "#" + storeId,
        sk: appConstants.DYNAMO_ENTITY_ITEM + "#" + itemId,
      },
      UpdateExpression:
        "SET storeItemId = :storeItemId, storeItemCategoryId = :storeItemCategoryId, storeItemImageUris = :storeItemImageUris, storeItemName = :storeItemName, storeItemStock = :storeItemStock, storeItemPrice = :storeItemPrice, storeItemDescription = :storeItemDescription, storeItemIsActive = :storeItemIsActive, storeItemTags = :storeItemTags, storeItemDiscountPercent = :storeItemDiscountPercent, storeItemCustomParams = :storeItemCustomParams",
      ExpressionAttributeValues: {
        ":storeItemId": itemId,
        ":storeItemCategoryId": storeItem.storeItemCategoryId,
        ":storeItemImageUris": storeItem.storeItemImageUris,
        ":storeItemName": storeItem.storeItemName,
        ":storeItemStock": storeItem.storeItemStock,
        ":storeItemPrice": storeItem.storeItemPrice,
        ":storeItemDescription": storeItem.storeItemDescription,
        ":storeItemIsActive": storeItem.storeItemIsActive,
        ":storeItemTags": storeItem.storeItemTags,
        ":storeItemDiscountPercent": storeItem.storeItemDiscountPercent,
        ":storeItemCustomParams": storeItem.storeItemCustomParams,
      },
    });
    await dynamoDbDocumentClient.send(command);
    return itemId;
  } catch (e) {
    console.error("In updateStoreItem", e);
    throw e;
  }
}

export async function deleteStoreItem(
  storeId: string,
  storeItemId: string
): Promise<void> {
  try {
    const command = new DeleteCommand({
      TableName: DEFAULT_TABLE_NAME,
      Key: {
        pk: appConstants.DYNAMO_ENTITY_STORE + "#" + storeId,
        sk: appConstants.DYNAMO_ENTITY_ITEM + "#" + storeItemId,
      },
    });
    await dynamoDbDocumentClient.send(command);
  } catch (e) {
    console.error("In deleteStoreItem", e);
    throw e;
  }
}

export async function updateStoreCategory(
  storeId: string,
  storeCategory: StoreCategory,
  storeCategoryId: string | undefined
): Promise<string> {
  try {
    const categoryId: string =
      storeCategoryId && storeCategoryId.length > 0
        ? storeCategoryId
        : ULID.ulid();
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

export async function deleteStoreCategory(
  storeId: string,
  storeCategoryId: string
): Promise<void> {
  try {
    const command = new DeleteCommand({
      TableName: DEFAULT_TABLE_NAME,
      Key: {
        pk: appConstants.DYNAMO_ENTITY_STORE + "#" + storeId,
        sk: appConstants.DYNAMO_ENTITY_CATEGORY + "#" + storeCategoryId,
      },
    });
    await dynamoDbDocumentClient.send(command);
  } catch (e) {
    console.error("In deleteStoreCategory", e);
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

    const [categoriesResult, itemsResult, settingsResult] = await Promise.all([
      dynamoDbDocumentClient.send(categoriesCommand),
      dynamoDbDocumentClient.send(itemsCommand),
      dynamoDbDocumentClient.send(settingsCommand),
    ]);

    const categories: StoreCategory[] = (categoriesResult.Items ?? []).map(
      (record) => {
        const { pk: _pk, sk: _sk, ...rest } = record;
        return rest as StoreCategory;
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
      items,
      settings,
    };
  } catch (e) {
    console.error("In getStoreInventoryData", e);
    throw e;
  }
}

export async function updateStoreSettings(
  storeId: string,
  storeSettings: StoreSettings
): Promise<void> {
  try {
    const command = new UpdateCommand({
      TableName: DEFAULT_TABLE_NAME,
      Key: {
        pk: appConstants.DYNAMO_ENTITY_STORE + "#" + storeId,
        sk: appConstants.DYNAMO_ENTITY_SETTINGS,
      },
      UpdateExpression:
        "SET \
            #templateId = :templateId, \
            #themeId = :themeId, \
            #contactInfo = :contactInfo, \
            #purchaseRewards = :purchaseRewards, \
            #socialMediaLinks = :socialMediaLinks, \
            #currencies = :currencies, \
            #general = :general, \
            #customize = :customize \
        ",
      ExpressionAttributeNames: {
        "#templateId": "templateId",
        "#themeId": "themeId",
        "#contactInfo": "contactInfo",
        "#purchaseRewards": "purchaseRewards",
        "#socialMediaLinks": "socialMediaLinks",
        "#currencies": "currencies",
        "#general": "general",
        "#customize": "customize",
      },
      ExpressionAttributeValues: {
        ":templateId": storeSettings.templateId,
        ":themeId": storeSettings.themeId,
        ":contactInfo": storeSettings.contactInfo,
        ":purchaseRewards": storeSettings.purchaseRewards,
        ":socialMediaLinks": storeSettings.socialMediaLinks,
        ":currencies": storeSettings.currencies,
        ":general": storeSettings.general,
        ":customize": storeSettings.customize,
      },
    });
    await dynamoDbDocumentClient.send(command);
  } catch (e) {
    console.error("In updateStoreSettings", e);
    throw e;
  }
}
