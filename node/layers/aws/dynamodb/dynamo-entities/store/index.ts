// Imports
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import * as ULID from "ulid";
import { appConstants } from "../../../../../constants";
import { dynamoWriteManyItems } from "../../dynamo-batch-ops";
import { queryAllWithPrefix } from "../../dynamo-query";
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

/* Thrown when a write targets a store, category or item that doesn't exist. Routes map it to 404. */
export class StoreRecordNotFoundError extends Error {
  constructor(what: "Store" | "Category" | "Item") {
    super(`${what} not found`);
    this.name = "StoreRecordNotFoundError";
  }
}

function isConditionalCheckFailure(e: unknown): boolean {
  return (e as { name?: string })?.name === "ConditionalCheckFailedException";
}

/* In a create transaction, reason 0 is the store's SETTINGS check. */
function isStoreMissingInTransaction(e: unknown): boolean {
  const err = e as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return (
    err?.name === "TransactionCanceledException" &&
    err.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed"
  );
}

/*
 * Write a category or item row under STORE#<storeId> without ever upserting blindly:
 * - create: a fresh ULID (any client ID is ignored), only if the store's SETTINGS row exists and
 *   the new row doesn't;
 * - update: the given ID, only if that row already exists.
 */
async function writeStoreChild(
  storeId: string,
  entity: "Category" | "Item",
  childId: string | undefined,
  isUpdate: boolean,
  updateExpression: string,
  values: (id: string) => Record<string, unknown>
): Promise<string> {
  if (isUpdate && !childId) {
    throw new Error(`${entity} update needs an ID`);
  }
  const id = isUpdate ? (childId as string) : ULID.ulid();
  const pk = appConstants.DYNAMO_ENTITY_STORE + "#" + storeId;
  const skPrefix =
    entity === "Category" ? appConstants.DYNAMO_ENTITY_CATEGORY : appConstants.DYNAMO_ENTITY_ITEM;
  const update = {
    TableName: DEFAULT_TABLE_NAME,
    Key: { pk, sk: skPrefix + "#" + id },
    UpdateExpression: updateExpression,
    ExpressionAttributeValues: values(id),
  };

  try {
    if (isUpdate) {
      await dynamoDbDocumentClient.send(
        new UpdateCommand({ ...update, ConditionExpression: "attribute_exists(pk)" })
      );
    } else {
      await dynamoDbDocumentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: DEFAULT_TABLE_NAME,
                Key: { pk, sk: appConstants.DYNAMO_ENTITY_SETTINGS },
                ConditionExpression: "attribute_exists(pk)",
              },
            },
            { Update: { ...update, ConditionExpression: "attribute_not_exists(pk)" } },
          ],
        })
      );
    }
  } catch (e) {
    if (isUpdate && isConditionalCheckFailure(e)) throw new StoreRecordNotFoundError(entity);
    if (!isUpdate && isStoreMissingInTransaction(e)) throw new StoreRecordNotFoundError("Store");
    throw e;
  }
  return id;
}

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
  storeItemId: string | undefined,
  isUpdate: boolean
): Promise<string> {
  try {
    return await writeStoreChild(
      storeId,
      "Item",
      storeItemId,
      isUpdate,
      "SET storeItemId = :storeItemId, storeItemCategoryId = :storeItemCategoryId, storeItemImageUris = :storeItemImageUris, storeItemName = :storeItemName, storeItemStock = :storeItemStock, storeItemPrice = :storeItemPrice, storeItemDescription = :storeItemDescription, storeItemIsActive = :storeItemIsActive, storeItemHashtagIds = :storeItemHashtagIds, storeItemDiscountPercent = :storeItemDiscountPercent, storeItemCustomParams = :storeItemCustomParams",
      (id) => ({
        ":storeItemId": id,
        ":storeItemCategoryId": storeItem.storeItemCategoryId,
        ":storeItemImageUris": storeItem.storeItemImageUris,
        ":storeItemName": storeItem.storeItemName,
        ":storeItemStock": storeItem.storeItemStock,
        ":storeItemPrice": storeItem.storeItemPrice,
        ":storeItemDescription": storeItem.storeItemDescription,
        ":storeItemIsActive": storeItem.storeItemIsActive,
        ":storeItemHashtagIds": storeItem.storeItemHashtagIds,
        ":storeItemDiscountPercent": storeItem.storeItemDiscountPercent,
        ":storeItemCustomParams": storeItem.storeItemCustomParams,
      })
    );
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
  storeCategoryId: string | undefined,
  isUpdate: boolean
): Promise<string> {
  try {
    return await writeStoreChild(
      storeId,
      "Category",
      storeCategoryId,
      isUpdate,
      "SET storeCategoriyId = :storeCategoriyId, storeCategoriyPriority = :storeCategoriyPriority, storeCategoryName = :storeCategoryName, storeCategoryBannerUri = :storeCategoryBannerUri, storeCategoryIsActive = :storeCategoryIsActive, storeCategoryDiscountPercent = :storeCategoryDiscountPercent, storeCategoriyHashtags = :storeCategoriyHashtags, storeCategoryItemCount = :storeCategoryItemCount",
      (id) => ({
        ":storeCategoriyId": id,
        ":storeCategoriyPriority": storeCategory.storeCategoriyPriority,
        ":storeCategoryName": storeCategory.storeCategoryName,
        ":storeCategoryBannerUri": storeCategory.storeCategoryBannerUri,
        ":storeCategoryIsActive": storeCategory.storeCategoryIsActive,
        ":storeCategoryDiscountPercent":
          storeCategory.storeCategoryDiscountPercent,
        ":storeCategoriyHashtags": storeCategory.storeCategoriyHashtags,
        ":storeCategoryItemCount": 0,
      })
    );
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
    const settingsCommand = new GetCommand({
      TableName: DEFAULT_TABLE_NAME,
      Key: {
        pk: storePk,
        sk: appConstants.DYNAMO_ENTITY_SETTINGS,
      },
    });

    const [categoryRecords, itemRecords, settingsResult] = await Promise.all([
      queryAllWithPrefix(storePk, appConstants.DYNAMO_ENTITY_CATEGORY + "#"),
      queryAllWithPrefix(storePk, appConstants.DYNAMO_ENTITY_ITEM + "#"),
      dynamoDbDocumentClient.send(settingsCommand),
    ]);

    const categories: StoreCategory[] = categoryRecords.map(
      (record) => {
        const { pk: _pk, sk: _sk, ...rest } = record;
        return rest as StoreCategory;
      }
    );
    const items: StoreItem[] = itemRecords.map((record) => {
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
            #storeInfo = :storeInfo, \
            #purchaseRewards = :purchaseRewards, \
            #socialMediaLinks = :socialMediaLinks, \
            #currencies = :currencies, \
            #general = :general, \
            #customize = :customize \
        ",
      ExpressionAttributeNames: {
        "#templateId": "templateId",
        "#themeId": "themeId",
        "#storeInfo": "storeInfo",
        "#purchaseRewards": "purchaseRewards",
        "#socialMediaLinks": "socialMediaLinks",
        "#currencies": "currencies",
        "#general": "general",
        "#customize": "customize",
      },
      ExpressionAttributeValues: {
        ":templateId": storeSettings.templateId,
        ":themeId": storeSettings.themeId,
        ":storeInfo": storeSettings.storeInfo,
        ":purchaseRewards": storeSettings.purchaseRewards,
        ":socialMediaLinks": storeSettings.socialMediaLinks,
        ":currencies": storeSettings.currencies,
        ":general": storeSettings.general,
        ":customize": storeSettings.customize ?? {},
      },
      // Never create a SETTINGS row for a store that doesn't exist.
      ConditionExpression: "attribute_exists(pk)",
    });
    await dynamoDbDocumentClient.send(command);
  } catch (e) {
    console.error("In updateStoreSettings", e);
    if (isConditionalCheckFailure(e)) throw new StoreRecordNotFoundError("Store");
    throw e;
  }
}

////////////////////////////////////////
// Admin-only settings (progress.md 1.6)
////////////////////////////////////////
export type StoreAdminSettings = StoreSettings["admin"];

const defaultAdminSettings = (): StoreAdminSettings => ({ ...initStoreSettings().admin });

/* The store's admin block (platform commission, store live), or null if there's no such store. */
export async function getStoreAdminSettings(storeId: string): Promise<StoreAdminSettings | null> {
  const res = await dynamoDbDocumentClient.send(
    new GetCommand({
      TableName: DEFAULT_TABLE_NAME,
      Key: { pk: appConstants.DYNAMO_ENTITY_STORE + "#" + storeId, sk: appConstants.DYNAMO_ENTITY_SETTINGS },
      ProjectionExpression: "#pk, #admin",
      ExpressionAttributeNames: { "#pk": "pk", "#admin": "admin" },
    })
  );
  if (!res.Item) return null;
  return { ...defaultAdminSettings(), ...(res.Item.admin ?? {}) };
}

/* Replace the admin block. Only the admin route calls this; merchants' update-settings never does. */
export async function updateStoreAdminSettings(
  storeId: string,
  admin: StoreAdminSettings
): Promise<StoreAdminSettings> {
  const value: StoreAdminSettings = { salesCommission: admin.salesCommission, isStoreLive: admin.isStoreLive };
  try {
    await dynamoDbDocumentClient.send(
      new UpdateCommand({
        TableName: DEFAULT_TABLE_NAME,
        Key: { pk: appConstants.DYNAMO_ENTITY_STORE + "#" + storeId, sk: appConstants.DYNAMO_ENTITY_SETTINGS },
        UpdateExpression: "SET #admin = :admin",
        ExpressionAttributeNames: { "#admin": "admin" },
        ExpressionAttributeValues: { ":admin": value },
        ConditionExpression: "attribute_exists(pk)",
      })
    );
  } catch (e) {
    if (isConditionalCheckFailure(e)) throw new StoreRecordNotFoundError("Store");
    throw e;
  }
  return value;
}

/* The same data without the admin block, for merchants and the public storefront. */
export function withoutAdminSettings(data: StoreInventoryData): StoreInventoryData {
  const { admin: _admin, ...settings } = data.settings;
  return { ...data, settings: settings as StoreSettings };
}

