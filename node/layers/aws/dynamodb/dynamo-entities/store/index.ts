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
import { queryAllInPartition, queryAllWithPrefix } from "../../dynamo-query";
import { deleteS3FilesPrefixed } from "../../../s3";
import { S3_STORAGE_BUCKET_NAME } from "../../../../../config";
import { DB_TABLE_NAME } from "../../../../../config";
import {
  initStore,
  initStoreSettings,
  normalizeAdminSettings,
  normalizeStoreLifecycle,
  initStoreLifecycle,
  StoreLifecycle,
  StoreCategory,
  StoreInventoryData,
  StoreItem,
  StoreOverview,
  StoreParameter,
  StorePayments,
  StoreSettings,
} from "../../../../core/interfaces/store";
import { getStorageImageUrl } from "../../../../core/utils";
import { publicVariants, variantsReady } from "../../../../core/variants";
import { reserveSlugPut, SlugTakenError, slugKey, transactionFailedAt } from "../slug";
import { newStoreMembershipItems } from "../membership";
import { StorePlan } from "../../../../core/plans";
import { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";

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

/*
 * Create a store: overview row, settings row and the slug reservation, all or nothing.
 * Throws SlugTakenError when another store holds the slug (1.8).
 */
export async function createStore(
  storeName: string,
  storeSlug: string,
  /** Self-serve (P.3): the signed-in user who becomes the store's ADMIN, in the same transaction. */
  owner?: { userId: string }
): Promise<StoreOverview> {
  try {
    const storeId: string = ULID.ulid();
    const now = Date.now();
    const storeOverview: StoreOverview = initStore(storeId, storeName, storeSlug);
    const storeSettings: StoreSettings = initStoreSettings();
    storeSettings.lifecycle = { ...initStoreLifecycle(now), ...(owner ? { createdByUserId: owner.userId } : {}) };
    // The storefront shows storeInfo.storeName, so a new store starts with the name it was given.
    storeSettings.storeInfo = { ...storeSettings.storeInfo, storeName };
    try {
      await dynamoDbDocumentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: DEFAULT_TABLE_NAME,
                Item: {
                  pk: appConstants.DYNAMO_ENTITY_APP_STORE,
                  sk: `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}#${appConstants.DYNAMO_ENTITY_OVERVIEW}`,
                  ...storeOverview,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: DEFAULT_TABLE_NAME,
                Item: {
                  pk: appConstants.DYNAMO_ENTITY_STORE + "#" + storeId,
                  sk: appConstants.DYNAMO_ENTITY_SETTINGS,
                  ...storeSettings,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            reserveSlugPut(storeSlug, storeId),
            // 3: the owner's PROFILE#INFO check, then their two membership rows
            ...(owner ? newStoreMembershipItems(storeId, owner.userId, "ADMIN", now) : []),
          ],
        })
      );
    } catch (e) {
      if (transactionFailedAt(e, 2)) throw new SlugTakenError(storeSlug);
      if (owner && transactionFailedAt(e, 3)) throw new StoreOwnerNotFoundError();
      throw e;
    }
    return storeOverview;
  } catch (e) {
    if (!(e instanceof SlugTakenError) && !(e instanceof StoreOwnerNotFoundError)) console.error("In createStore", e);
    throw e;
  }
}

/* The store left DRAFT before this Go Live finished (another request, or an admin) (P.4b). */
export class StoreStatusChangedError extends Error {
  constructor() {
    super("The store's status changed");
    this.name = "StoreStatusChangedError";
  }
}

/*
 * Go Live's write (P.4b): DRAFT → LIVE, or DRAFT → IN_REVIEW when runSmartStoreValidation flagged
 * the store. Conditional on the store still being a DRAFT, so two Go Lives (or an admin change)
 * can't both win. IN_REVIEW keeps the reasons and the requested plan in the SETTINGS row's own
 * `review` attribute, which only admins see (members' get-data and public data drop it).
 */
export async function setStoreStatusFromDraft(
  storeId: string,
  change: {
    status: "LIVE" | "IN_REVIEW";
    plan: StorePlan;
    previous: StoreLifecycle;
    review?: { reasons: string[]; requestedByUserId: string | null };
  }
): Promise<StoreLifecycle> {
  const now = Date.now();
  const { pausedReason: _paused, ...previous } = change.previous;
  const lifecycle: StoreLifecycle = {
    ...previous,
    status: change.status,
    plan: change.plan,
    statusChangedAt: now,
    ...(change.status === "LIVE" && !change.previous.firstLiveAt ? { firstLiveAt: now } : {}),
  };
  const names: Record<string, string> = { "#lc": "lifecycle", "#st": "status" };
  const values: Record<string, unknown> = { ":lc": lifecycle, ":draft": "DRAFT" };
  let update = "SET #lc = :lc";
  if (change.review) {
    names["#review"] = "review";
    values[":review"] = { ...change.review, requestedPlan: change.plan, requestedAt: now };
    update += ", #review = :review";
  } else {
    names["#review"] = "review";
    update += " REMOVE #review";
  }
  try {
    await dynamoDbDocumentClient.send(
      new UpdateCommand({
        TableName: DEFAULT_TABLE_NAME,
        Key: storeKey(storeId, appConstants.DYNAMO_ENTITY_SETTINGS),
        UpdateExpression: update,
        ConditionExpression: "#lc.#st = :draft",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
  } catch (e) {
    if (isConditionalCheckFailure(e)) throw new StoreStatusChangedError();
    throw e;
  }
  return lifecycle;
}

/* createStore's owner has no PROFILE#INFO row (P.3). */
export class StoreOwnerNotFoundError extends Error {
  constructor() {
    super("Profile not found");
    this.name = "StoreOwnerNotFoundError";
  }
}

const ITEM_SET_EXPRESSION =
  "SET storeItemId = :storeItemId, storeItemCategoryId = :storeItemCategoryId, storeItemImageUris = :storeItemImageUris, storeItemName = :storeItemName, storeItemStock = :storeItemStock, storeItemPrices = :storeItemPrices, storeItemDescription = :storeItemDescription, storeItemIsActive = :storeItemIsActive, storeItemHashtagIds = :storeItemHashtagIds, storeItemDiscountPercent = :storeItemDiscountPercent, storeItemCustomParams = :storeItemCustomParams, storeItemVariants = :storeItemVariants REMOVE storeItemPrice";

function itemValues(id: string, storeItem: StoreItem): Record<string, unknown> {
  return {
    ":storeItemId": id,
    ":storeItemCategoryId": storeItem.storeItemCategoryId,
    ":storeItemImageUris": storeItem.storeItemImageUris,
    ":storeItemName": storeItem.storeItemName,
    ":storeItemStock": storeItem.storeItemStock,
    ":storeItemPrices": storeItem.storeItemPrices,
    ":storeItemDescription": storeItem.storeItemDescription,
    ":storeItemIsActive": storeItem.storeItemIsActive,
    ":storeItemHashtagIds": storeItem.storeItemHashtagIds,
    ":storeItemDiscountPercent": storeItem.storeItemDiscountPercent,
    ":storeItemCustomParams": storeItem.storeItemCustomParams,
    ":storeItemVariants": storeItem.storeItemVariants ?? [],
  };
}

const storeKey = (storeId: string, sk: string) => ({
  pk: appConstants.DYNAMO_ENTITY_STORE + "#" + storeId,
  sk,
});
const itemKey = (storeId: string, itemId: string) =>
  storeKey(storeId, appConstants.DYNAMO_ENTITY_ITEM + "#" + itemId);
const categoryKey = (storeId: string, categoryId: string) =>
  storeKey(storeId, appConstants.DYNAMO_ENTITY_CATEGORY + "#" + categoryId);

/*
 * Transaction part: add `delta` to a category's item count (2.1). Only if the category exists,
 * so a count change can never create a stray category row.
 */
function categoryCountChange(storeId: string, categoryId: string, delta: 1 | -1) {
  return {
    Update: {
      TableName: DEFAULT_TABLE_NAME,
      Key: categoryKey(storeId, categoryId),
      UpdateExpression: "ADD storeCategoryItemCount :delta",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":delta": delta },
    },
  };
}

async function rowExists(key: { pk: string; sk: string }): Promise<boolean> {
  const r = await dynamoDbDocumentClient.send(
    new GetCommand({ TableName: DEFAULT_TABLE_NAME, Key: key, ConsistentRead: true, ProjectionExpression: "pk" })
  );
  return !!r.Item;
}

async function getItemCategoryId(storeId: string, itemId: string): Promise<string | null> {
  const r = await dynamoDbDocumentClient.send(
    new GetCommand({
      TableName: DEFAULT_TABLE_NAME,
      Key: itemKey(storeId, itemId),
      ConsistentRead: true,
      ProjectionExpression: "storeItemCategoryId",
    })
  );
  if (!r.Item) return null;
  return typeof r.Item.storeItemCategoryId === "string" ? r.Item.storeItemCategoryId : "";
}

/* Whether a category or item exists in the store (2.3c: upload slots only for real records). */
export async function storeChildExists(
  storeId: string,
  entity: "Category" | "Item",
  id: string
): Promise<boolean> {
  return rowExists(entity === "Item" ? itemKey(storeId, id) : categoryKey(storeId, id));
}

/* How many times an item write is retried when its category changed between our read and write. */
const ITEM_WRITE_ATTEMPTS = 3;

/*
 * Create or update an item, keeping `storeCategoryItemCount` right (2.1):
 * - create: a fresh ULID; in one transaction, only if the store exists, the row is new and the
 *   category exists (+1 to it);
 * - update: only if the row exists; when the item moves category, +1 to the new one and -1 to the
 *   old one (if it still exists) in the same transaction as the item write.
 * Throws StoreRecordNotFoundError for a missing store, item or category.
 */
export async function updateStoreItem(
  storeId: string,
  storeItem: StoreItem,
  storeItemId: string | undefined,
  isUpdate: boolean
): Promise<string> {
  try {
    if (isUpdate && !storeItemId) throw new Error("Item update needs an ID");
    const newCategoryId = storeItem.storeItemCategoryId;

    if (!isUpdate) {
      const id = ULID.ulid();
      try {
        await dynamoDbDocumentClient.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: DEFAULT_TABLE_NAME,
                  Key: storeKey(storeId, appConstants.DYNAMO_ENTITY_SETTINGS),
                  ConditionExpression: "attribute_exists(pk)",
                },
              },
              {
                Update: {
                  TableName: DEFAULT_TABLE_NAME,
                  Key: itemKey(storeId, id),
                  UpdateExpression: ITEM_SET_EXPRESSION,
                  ExpressionAttributeValues: itemValues(id, storeItem),
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
              categoryCountChange(storeId, newCategoryId, 1),
            ],
          })
        );
      } catch (e) {
        if (transactionFailedAt(e, 0)) throw new StoreRecordNotFoundError("Store");
        if (transactionFailedAt(e, 2)) throw new StoreRecordNotFoundError("Category");
        throw e;
      }
      return id;
    }

    const id = storeItemId as string;
    for (let attempt = 0; attempt < ITEM_WRITE_ATTEMPTS; attempt++) {
      const oldCategoryId = await getItemCategoryId(storeId, id);
      if (oldCategoryId === null) throw new StoreRecordNotFoundError("Item");
      const moved = oldCategoryId !== newCategoryId;
      const itemUpdate = {
        Update: {
          TableName: DEFAULT_TABLE_NAME,
          Key: itemKey(storeId, id),
          UpdateExpression: ITEM_SET_EXPRESSION,
          ExpressionAttributeValues: { ...itemValues(id, storeItem), ":oldCategoryId": oldCategoryId },
          // Same category as when we read it, so the counts we change below are the right ones.
          ConditionExpression: "attribute_exists(pk) AND storeItemCategoryId = :oldCategoryId",
        },
      };
      const transactItems: NonNullable<TransactWriteCommandInput["TransactItems"]> = [itemUpdate];
      if (moved) {
        transactItems.push(categoryCountChange(storeId, newCategoryId, 1));
        // An old category that's already gone (left over from before 2.2) has no count to fix.
        if (oldCategoryId && (await rowExists(categoryKey(storeId, oldCategoryId)))) {
          transactItems.push(categoryCountChange(storeId, oldCategoryId, -1));
        }
      }
      try {
        await dynamoDbDocumentClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
        return id;
      } catch (e) {
        if (moved && transactionFailedAt(e, 1)) throw new StoreRecordNotFoundError("Category");
        if (transactionFailedAt(e, 0) || transactionFailedAt(e, 2)) continue; // changed under us
        throw e;
      }
    }
    throw new Error("Item changed while saving; gave up after 3 tries");
  } catch (e) {
    if (!(e instanceof StoreRecordNotFoundError)) console.error("In updateStoreItem", e);
    throw e;
  }
}

/*
 * Delete an item and take it off its category's count (2.1), in one transaction.
 * Returns false when the item was already gone.
 */
export async function deleteStoreItem(storeId: string, storeItemId: string): Promise<boolean> {
  try {
    for (let attempt = 0; attempt < ITEM_WRITE_ATTEMPTS; attempt++) {
      const categoryId = await getItemCategoryId(storeId, storeItemId);
      if (categoryId === null) return false;
      const transactItems: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
        {
          Delete: {
            TableName: DEFAULT_TABLE_NAME,
            Key: itemKey(storeId, storeItemId),
            ConditionExpression: "attribute_exists(pk) AND storeItemCategoryId = :categoryId",
            ExpressionAttributeValues: { ":categoryId": categoryId },
          },
        },
      ];
      if (categoryId && (await rowExists(categoryKey(storeId, categoryId)))) {
        transactItems.push(categoryCountChange(storeId, categoryId, -1));
      }
      try {
        await dynamoDbDocumentClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
        return true;
      } catch (e) {
        if (transactionFailedAt(e, 0) || transactionFailedAt(e, 1)) continue; // changed under us
        throw e;
      }
    }
    throw new Error("Item changed while deleting; gave up after 3 tries");
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
      // The item count is kept by the item writes (2.1): a new category starts at 0, and saving a
      // category never touches it.
      "SET storeCategoriyId = :storeCategoriyId, storeCategoriyPriority = :storeCategoriyPriority, storeCategoryName = :storeCategoryName, storeCategoryBannerUri = :storeCategoryBannerUri, storeCategoryIsActive = :storeCategoryIsActive, storeCategoryDiscountPercent = :storeCategoryDiscountPercent, storeCategoriyHashtags = :storeCategoriyHashtags" +
        (isUpdate ? "" : ", storeCategoryItemCount = :storeCategoryItemCount"),
      (id) => ({
        ":storeCategoriyId": id,
        ":storeCategoriyPriority": storeCategory.storeCategoriyPriority,
        ":storeCategoryName": storeCategory.storeCategoryName,
        ":storeCategoryBannerUri": storeCategory.storeCategoryBannerUri,
        ":storeCategoryIsActive": storeCategory.storeCategoryIsActive,
        ":storeCategoryDiscountPercent":
          storeCategory.storeCategoryDiscountPercent,
        ":storeCategoriyHashtags": storeCategory.storeCategoriyHashtags,
        ...(isUpdate ? {} : { ":storeCategoryItemCount": 0 }),
      })
    );
  } catch (e) {
    console.error("In updateStoreCategory", e);
    throw e;
  }
}

/* Thrown when deleting a category that still has items (2.2). Routes map it to 409. */
export class CategoryNotEmptyError extends Error {
  constructor(public readonly itemCount: number) {
    super(
      `This category still has ${itemCount} item${itemCount === 1 ? "" : "s"}. Move or delete ${
        itemCount === 1 ? "it" : "them"
      } first.`
    );
    this.name = "CategoryNotEmptyError";
  }
}

/*
 * Delete a category, only while it has no items (2.2). The check rides on the delete itself
 * (`storeCategoryItemCount`, kept by the item writes since 2.1), so it can't race an item being
 * added: item creates and moves need the category to exist. Deleting a category that's already
 * gone is a no-op. Throws CategoryNotEmptyError.
 */
export async function deleteStoreCategory(
  storeId: string,
  storeCategoryId: string
): Promise<void> {
  try {
    await dynamoDbDocumentClient.send(
      new DeleteCommand({
        TableName: DEFAULT_TABLE_NAME,
        Key: categoryKey(storeId, storeCategoryId),
        ConditionExpression:
          "attribute_not_exists(pk) OR attribute_not_exists(storeCategoryItemCount) OR storeCategoryItemCount <= :zero",
        ExpressionAttributeValues: { ":zero": 0 },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      })
    );
  } catch (e) {
    if (isConditionalCheckFailure(e)) {
      // The failed item comes back raw ({ N: "3" }); the document client doesn't unmarshall errors.
      const raw = (e as { Item?: Record<string, unknown> }).Item?.storeCategoryItemCount;
      const count = Number(typeof raw === "object" && raw !== null ? (raw as { N?: string }).N : raw);
      throw new CategoryNotEmptyError(Number.isFinite(count) && count > 0 ? count : 1);
    }
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
      settings = {
        ...rest,
        admin: normalizeAdminSettings(rest.admin),
        lifecycle: normalizeStoreLifecycle(rest.lifecycle),
      } as StoreSettings;
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

/* contactFormAvailable is worked out for public responses; it's never saved. */
function withoutPublicOnlyInfo(info: StoreSettings["storeInfo"]): StoreSettings["storeInfo"] {
  const { contactFormAvailable: _ignored, ...rest } = info;
  return rest;
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
        ":storeInfo": withoutPublicOnlyInfo(storeSettings.storeInfo),
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

/* The store's admin block (platform commission mode/amounts, store live), or null if there's no such store. */
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
  return normalizeAdminSettings(res.Item.admin);
}

/* Replace the admin block. Only the admin route calls this; merchants' update-settings never does. */
export async function updateStoreAdminSettings(
  storeId: string,
  admin: StoreAdminSettings
): Promise<StoreAdminSettings> {
  // Only the known fields, so nothing else in the body can reach the admin block.
  const value: StoreAdminSettings = {
    commissionMode: admin.commissionMode,
    commissionPercentBps: admin.commissionPercentBps,
    salesCommissions: admin.salesCommissions,
    suspended: admin.suspended,
  };
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
  const {
    admin: _admin,
    payments: _payments,
    review: _review,
    subscription: _subscription,
    billingCheckout: _checkout,
    ...settings
  } = data.settings;
  return { ...data, settings: settings as StoreSettings };
}

////////////////////////////////////////
// Public storefront data (progress.md 2.4)
////////////////////////////////////////
/* The store exists but an admin has suspended it (`admin.suspended`, P.2). */
export class StoreUnavailableError extends Error {
  constructor() {
    super("Store unavailable");
    this.name = "StoreUnavailableError";
  }
}

/*
 * The store exists and isn't suspended, but it isn't LIVE yet (DRAFT or IN_REVIEW, P.2). Carries
 * what a "Coming soon" page may show (`comingSoonSettings`). Shoppers can't see its items, get a
 * quote, open an item link or use Contact us.
 */
export class StoreNotLiveError extends Error {
  constructor(readonly settings: StoreSettings) {
    super("Store not live");
    this.name = "StoreNotLiveError";
  }
}

/*
 * Throws StoreUnavailableError (suspended) or StoreNotLiveError (not LIVE) for a SETTINGS row.
 * Suspension wins: a suspended draft is just unavailable.
 */
function assertStoreOpen(row: Record<string, any>): void {
  if (normalizeAdminSettings(row.admin).suspended) throw new StoreUnavailableError();
  if (normalizeStoreLifecycle(row.lifecycle).status !== "LIVE") {
    const { pk: _pk, sk: _sk, ...settings } = row;
    throw new StoreNotLiveError(comingSoonSettings(settings as StoreSettings));
  }
}

/*
 * What a "Coming soon" page may show for a store that isn't live (P.2): its name, slogan, logo,
 * look and currencies. No contact details, links or pickup address: a draft hasn't been through
 * Go Live's checks (P.4c), so nothing in it is offered to shoppers yet.
 */
export function comingSoonSettings(settings: StoreSettings): StoreSettings {
  const { admin: _a, lifecycle: _l, ...base } = initStoreSettings();
  const info = settings.storeInfo ?? base.storeInfo;
  const { admin: _admin, payments: _p, review: _r, lifecycle, ...rest } = settings;
  return {
    ...base,
    templateId: rest.templateId ?? base.templateId,
    themeId: rest.themeId ?? base.themeId,
    customize: rest.customize ?? {},
    currencies: rest.currencies ?? base.currencies,
    storeInfo: {
      ...base.storeInfo,
      storeName: info.storeName ?? "",
      slogan: info.slogan ?? "",
      logoUri: info.logoUri ?? "",
      contactFormAvailable: false,
    },
    paymentsEnabled: false,
    storeStatus: normalizeStoreLifecycle(lifecycle).status,
  } as StoreSettings;
}

/*
 * The settings a shopper may see: the email and phone number are left out when the merchant hid
 * them (`showEmail` / `showPhone` false: often personal details), and `contactFormAvailable`
 * says whether Contact us can be offered (the store has an email; contact-store reads the real
 * one on the server).
 */
export function toPublicSettings(settings: StoreSettings): StoreSettings {
  const info = settings.storeInfo ?? initStoreSettings().storeInfo;
  const email = (info.emailaddress ?? "").trim();
  const { contactFormAvailable: _ignored, ...rest } = info;
  const { lifecycle, subscription: _s, billingCheckout: _c, ...others } = settings;
  return {
    ...others,
    paymentsEnabled: settings.payments?.chargesEnabled === true,
    storeStatus: normalizeStoreLifecycle(lifecycle).status,
    storeInfo: {
      ...rest,
      emailaddress: info.showEmail === false ? "" : info.emailaddress,
      phoneNumber: info.showPhone === false ? "" : info.phoneNumber,
      contactFormAvailable: email.length > 0,
    },
  };
}

/*
 * What a shopper may see: no admin block, the email only if shown (toPublicSettings), only active categories, only active items in them
 * (items of a missing or inactive category are left out), and each category's count is the
 * number of items returned, so hidden items aren't given away by the counts.
 * Prices (2.5) are cut to the currencies the store offers; an item priced in none of them can't
 * be bought, so it's left out too. Variant rows (2.7) are cut the same way, and rows that aren't
 * sold are left out; an item whose variant table isn't filled in is left out.
 */
export function toPublicInventory(data: StoreInventoryData): StoreInventoryData {
  const categories = data.categories.filter((c) => c.storeCategoryIsActive === true);
  const activeCategoryIds = new Set(categories.map((c) => c.storeCategoriyId));
  const offered = new Set(data.settings.currencies.map((c) => c.currencyCode));
  const items = data.items
    .filter((i) => i.storeItemIsActive === true && activeCategoryIds.has(i.storeItemCategoryId))
    // A variant item whose table isn't filled in (saved before 2.7) can't be bought yet.
    .filter((i) => variantsReady(i))
    .map((i) => ({
      ...i,
      storeItemPrices: Object.fromEntries(
        Object.entries(i.storeItemPrices ?? {}).filter(([code]) => offered.has(code))
      ),
      storeItemVariants: publicVariants(i.storeItemVariants, offered),
    }))
    .filter((i) => Object.keys(i.storeItemPrices).length > 0);
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.storeItemCategoryId, (counts.get(i.storeItemCategoryId) ?? 0) + 1);
  return withoutAdminSettings({
    settings: toPublicSettings(data.settings),
    categories: categories.map((c) => ({ ...c, storeCategoryItemCount: counts.get(c.storeCategoriyId) ?? 0 })),
    items,
  });
}

/*
 * The public storefront's data. Throws StoreRecordNotFoundError when the store doesn't exist,
 * StoreUnavailableError when it's suspended and StoreNotLiveError when it isn't LIVE (P.2);
 * settings saved before the admin block or the lifecycle existed count as live.
 */
export async function getPublicStoreInventoryData(storeId: string): Promise<StoreInventoryData> {
  await getPublicStoreSettings(storeId);
  return toPublicInventory(await getStoreInventoryData(storeId));
}

/* A live store's public settings; throws like getPublicStoreInventoryData. */
export async function getPublicStoreSettings(storeId: string): Promise<StoreSettings> {
  const settings = await dynamoDbDocumentClient.send(
    new GetCommand({ TableName: DEFAULT_TABLE_NAME, Key: storeKey(storeId, appConstants.DYNAMO_ENTITY_SETTINGS) })
  );
  if (!settings.Item) throw new StoreRecordNotFoundError("Store");
  assertStoreOpen(settings.Item);
  const { pk: _pk, sk: _sk, admin: _admin, payments, lifecycle: _lifecycle, review: _review, ...rest } = settings.Item;
  return { ...rest, paymentsEnabled: payments?.chargesEnabled === true, storeStatus: "LIVE" } as StoreSettings;
}

/*
 * One item for a deep link (3.3): the same rules as the storefront (live store, active category,
 * active item, a price in an offered currency). Returns null when the item isn't shown publicly,
 * so a hidden item looks the same as a missing one. Throws like getPublicStoreInventoryData for
 * an unknown or suspended store.
 */
export async function getPublicStoreItem(
  storeId: string,
  itemId: string
): Promise<{ item: StoreItem; category: StoreCategory; settings: StoreSettings } | null> {
  const [settingsRes, itemRes] = await Promise.all([
    dynamoDbDocumentClient.send(
      new GetCommand({ TableName: DEFAULT_TABLE_NAME, Key: storeKey(storeId, appConstants.DYNAMO_ENTITY_SETTINGS) })
    ),
    dynamoDbDocumentClient.send(new GetCommand({ TableName: DEFAULT_TABLE_NAME, Key: itemKey(storeId, itemId) })),
  ]);
  if (!settingsRes.Item) throw new StoreRecordNotFoundError("Store");
  assertStoreOpen(settingsRes.Item);
  if (!itemRes.Item) return null;
  const { pk: _ip, sk: _is, ...item } = itemRes.Item;
  const categoryRes = await dynamoDbDocumentClient.send(
    new GetCommand({ TableName: DEFAULT_TABLE_NAME, Key: categoryKey(storeId, String(item.storeItemCategoryId)) })
  );
  if (!categoryRes.Item) return null;
  const { pk: _cp, sk: _cs, ...category } = categoryRes.Item;
  const { pk: _sp, sk: _ss, ...settings } = settingsRes.Item;
  const shown = toPublicInventory({
    settings: settings as StoreSettings,
    categories: [category as StoreCategory],
    items: [item as StoreItem],
  });
  if (shown.items.length === 0) return null;
  return { item: shown.items[0], category: shown.categories[0], settings: shown.settings };
}

////////////////////////////////////////
// Delete a store (progress.md 1.7)
////////////////////////////////////////
/*
 * Delete everything that belongs to a store, in an order that is safe to retry after a failure:
 *   1. SETTINGS first. Every store write is conditional on it, so nothing new can be added
 *      while the rest is deleted.
 *   2. The rest of STORE#<id> (categories, items, members, invites, later orders), plus the
 *      reverse rows other partitions keep: USER#<member>/STORE#<id> and INVITE#<email>/STORE#<id>.
 *   3. The store's files under store/<id>/ in S3.
 *   4. The APP_STORE overview row last, so a store whose delete failed stays in the admin list
 *      and can be deleted again.
 * Returns false if there was nothing left to delete (no rows and no overview).
 */
export async function deleteStore(storeId: string): Promise<boolean> {
  const storePk = appConstants.DYNAMO_ENTITY_STORE + "#" + storeId;
  const userStoreSk = appConstants.DYNAMO_ENTITY_STORE + "#" + storeId;
  const overviewKey = {
    pk: appConstants.DYNAMO_ENTITY_APP_STORE,
    sk: `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}#${appConstants.DYNAMO_ENTITY_OVERVIEW}`,
  };

  const [rows, overview] = await Promise.all([
    queryAllInPartition(storePk, DEFAULT_TABLE_NAME),
    dynamoDbDocumentClient.send(new GetCommand({ TableName: DEFAULT_TABLE_NAME, Key: overviewKey })),
  ]);
  if (rows.length === 0 && !overview.Item) {
    return false;
  }

  // 1. Stop new writes
  if (rows.some((r) => r.sk === appConstants.DYNAMO_ENTITY_SETTINGS)) {
    await dynamoDbDocumentClient.send(
      new DeleteCommand({ TableName: DEFAULT_TABLE_NAME, Key: { pk: storePk, sk: appConstants.DYNAMO_ENTITY_SETTINGS } })
    );
  }

  // 2. The partition and the reverse rows that point at it
  const keys: { pk: string; sk: string }[] = [];
  for (const r of rows) {
    if (r.sk === appConstants.DYNAMO_ENTITY_SETTINGS) continue;
    keys.push({ pk: r.pk, sk: r.sk });
    if (r.sk.startsWith(appConstants.DYNAMO_ENTITY_MEMBER + "#")) {
      keys.push({ pk: appConstants.DYNAMO_ENTITY_USER + "#" + r.sk.slice(appConstants.DYNAMO_ENTITY_MEMBER.length + 1), sk: userStoreSk });
    } else if (r.sk.startsWith(appConstants.DYNAMO_ENTITY_INVITE + "#")) {
      keys.push({ pk: r.sk, sk: userStoreSk }); // INVITE#<email> / STORE#<id>
    }
  }
  if (keys.length > 0) {
    await dynamoWriteManyItems(DEFAULT_TABLE_NAME, keys.map((Key) => ({ DeleteRequest: { Key } })));
  }

  // 3. Files (the trailing slash keeps other stores' prefixes out)
  await deleteS3FilesPrefixed(S3_STORAGE_BUCKET_NAME, `store/${storeId}/`);

  // 4. The slug reservation (1.8), only while it's still this store's, then the admin list entry.
  //    The slug is read from the overview row, so it goes first: a retry can still find it.
  const storeSlug = overview.Item?.storeSlug;
  if (typeof storeSlug === "string" && storeSlug) {
    try {
      await dynamoDbDocumentClient.send(
        new DeleteCommand({
          TableName: DEFAULT_TABLE_NAME,
          Key: slugKey(storeSlug),
          ConditionExpression: "storeId = :storeId",
          ExpressionAttributeValues: { ":storeId": storeId },
        })
      );
    } catch (e) {
      if (!isConditionalCheckFailure(e)) throw e; // not ours, or already gone
    }
  }
  if (overview.Item) {
    await dynamoDbDocumentClient.send(new DeleteCommand({ TableName: DEFAULT_TABLE_NAME, Key: overviewKey }));
  }
  return true;
}


////////////////////////////////////////
// Payments: the store's Stripe account (5.2)
////////////////////////////////////////
const paymentsKey = (storeId: string) => storeKey(storeId, appConstants.DYNAMO_ENTITY_SETTINGS);

/* The store's payments attribute ({} when it has none). Throws StoreRecordNotFoundError. */
export async function getStorePayments(storeId: string): Promise<StorePayments> {
  const res = await dynamoDbDocumentClient.send(
    new GetCommand({
      TableName: DEFAULT_TABLE_NAME,
      Key: paymentsKey(storeId),
      ProjectionExpression: "#pk, #payments",
      ExpressionAttributeNames: { "#pk": "pk", "#payments": "payments" },
    })
  );
  if (!res.Item) throw new StoreRecordNotFoundError("Store");
  return (res.Item.payments ?? {}) as StorePayments;
}

/*
 * Save a newly created Stripe account unless the store already has one (two clicks at once).
 * Returns the account the store ends up with: this one, or the one saved first.
 */
export async function saveStoreStripeAccount(storeId: string, stripeAccountId: string): Promise<string> {
  const payments: StorePayments = {
    stripeAccountId,
    chargesEnabled: false,
    payoutsEnabled: false,
    detailsSubmitted: false,
    updatedAt: Date.now(),
  };
  try {
    await dynamoDbDocumentClient.send(
      new UpdateCommand({
        TableName: DEFAULT_TABLE_NAME,
        Key: paymentsKey(storeId),
        UpdateExpression: "SET #payments = :payments",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(#payments.#acct)",
        ExpressionAttributeNames: { "#payments": "payments", "#acct": "stripeAccountId" },
        ExpressionAttributeValues: { ":payments": payments },
      })
    );
    return stripeAccountId;
  } catch (e) {
    if (!isConditionalCheckFailure(e)) throw e;
    const existing = (await getStorePayments(storeId)).stripeAccountId;
    if (!existing) throw new StoreRecordNotFoundError("Store");
    return existing;
  }
}

/* Refresh the cached flags, only if the store still uses that account. Returns false otherwise. */
export async function updateStorePaymentsStatus(
  storeId: string,
  stripeAccountId: string,
  flags: Required<Pick<StorePayments, "chargesEnabled" | "payoutsEnabled" | "detailsSubmitted">>
): Promise<boolean> {
  try {
    await dynamoDbDocumentClient.send(
      new UpdateCommand({
        TableName: DEFAULT_TABLE_NAME,
        Key: paymentsKey(storeId),
        UpdateExpression:
          "SET #payments.#charges = :charges, #payments.#payouts = :payouts, #payments.#details = :details, #payments.#updated = :now",
        ConditionExpression: "#payments.#acct = :acct",
        ExpressionAttributeNames: {
          "#payments": "payments",
          "#acct": "stripeAccountId",
          "#charges": "chargesEnabled",
          "#payouts": "payoutsEnabled",
          "#details": "detailsSubmitted",
          "#updated": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":acct": stripeAccountId,
          ":charges": flags.chargesEnabled,
          ":payouts": flags.payoutsEnabled,
          ":details": flags.detailsSubmitted,
          ":now": Date.now(),
        },
      })
    );
    return true;
  } catch (e) {
    if (isConditionalCheckFailure(e)) return false;
    throw e;
  }
}

/*
 * The merchant disconnected that account from Ceseelia (or it's gone): forget it, keeping when
 * it happened, so the store stops taking payments and can connect a new one.
 */
export async function clearStoreStripeAccount(storeId: string, stripeAccountId: string): Promise<void> {
  try {
    await dynamoDbDocumentClient.send(
      new UpdateCommand({
        TableName: DEFAULT_TABLE_NAME,
        Key: paymentsKey(storeId),
        UpdateExpression: "SET #payments = :payments",
        ConditionExpression: "#payments.#acct = :acct",
        ExpressionAttributeNames: { "#payments": "payments", "#acct": "stripeAccountId" },
        ExpressionAttributeValues: { ":acct": stripeAccountId, ":payments": { disconnectedAt: Date.now() } },
      })
    );
  } catch (e) {
    if (!isConditionalCheckFailure(e)) throw e;
  }
}
