// Imports
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
  TransactWriteCommand,
  TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import * as ULID from "ulid";
import { appConstants } from "../../../../../constants";
import { dynamoWriteManyItems } from "../../dynamo-batch-ops";
import { DB_TABLE_NAME } from "../../../../../config";
import {
  initStore,
  initStoreSettings,
  StoreOverview,
  StoreSettings,
} from "../../../../core/interfaces/store";
import { formatEpochToFullReadableDate } from "../../../../core/utils";
import { StoreRecordNotFoundError } from "../store";
import {
  getSlugOwner,
  releaseSlugDelete,
  reserveSlugPut,
  SlugTakenError,
  transactionFailedAt,
} from "../slug";

// Initialize DynamoDB Document Client
const dynamoDbDocumentClient: DynamoDBDocumentClient =
  DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: appConstants.DEFAULT_REGION,
    })
  );

// Constants
const DEFAULT_TABLE_NAME: string | undefined = DB_TABLE_NAME;

export async function getAllStores() {
  try {
    const allStores: StoreOverview[] = [];
    let ExclusiveStartKey: any = undefined;

    do {
      const command = new QueryCommand({
        TableName: DEFAULT_TABLE_NAME,
        KeyConditionExpression: "#pk = :pk and begins_with(#sk, :sk_prefix)",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#sk": "sk",
        },
        ExpressionAttributeValues: {
          ":pk": appConstants.DYNAMO_ENTITY_APP_STORE,
          ":sk_prefix": appConstants.DYNAMO_ENTITY_STORE + "#",
        },
        ScanIndexForward: false,
        ExclusiveStartKey, // pagination point
      });

      const result = await dynamoDbDocumentClient.send(command);

      if (result.Items) {
        for (const record of result.Items) {
          delete record.pk;
          delete record.sk;

          record.storeOrderLastCompletedDateStr =
            record.storeOrderLastCompletedTimestamp <= 0
              ? appConstants.NA
              : formatEpochToFullReadableDate(
                  record.storeOrderLastCompletedTimestamp,
                  true
                );

          allStores.push(record as StoreOverview);
        }
      }

      ExclusiveStartKey = result.LastEvaluatedKey; // continue if exists
    } while (ExclusiveStartKey);

    return allStores;
  } catch (e) {
    console.error("In getAllStores", e);
    throw e;
  }
}

/*
 * Rename a store and/or change its slug (1.8; store admins too since P.11). In one transaction:
 * update the overview row (only if its slug is still the one we read), reserve the new slug, set
 * the storefront name (SETTINGS storeInfo.storeName) to the same name, and release the old slug
 * when it was ours. Throws StoreRecordNotFoundError (404) or SlugTakenError (409).
 */
export async function updateStoreInfo(
  storeId: string,
  storeName: string,
  storeSlug: string
): Promise<StoreOverview> {
  const overviewKey = {
    pk: appConstants.DYNAMO_ENTITY_APP_STORE,
    sk: `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}#${appConstants.DYNAMO_ENTITY_OVERVIEW}`,
  };
  try {
    // Retry only when someone else changed this store's slug between our read and our write.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await dynamoDbDocumentClient.send(
        new GetCommand({ TableName: DEFAULT_TABLE_NAME, Key: overviewKey, ConsistentRead: true })
      );
      if (!current.Item) throw new StoreRecordNotFoundError("Store");
      const oldSlug: string = typeof current.Item.storeSlug === "string" ? current.Item.storeSlug : "";

      const transactItems: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
        {
          Update: {
            TableName: DEFAULT_TABLE_NAME,
            Key: overviewKey,
            ConditionExpression: "attribute_exists(pk) AND #storeSlug = :oldSlug",
            UpdateExpression: "SET #storeName = :storeName, #storeSlug = :storeSlug",
            ExpressionAttributeNames: { "#storeName": "storeName", "#storeSlug": "storeSlug" },
            ExpressionAttributeValues: {
              ":storeName": storeName,
              ":storeSlug": storeSlug,
              ":oldSlug": oldSlug,
            },
          },
        },
        reserveSlugPut(storeSlug, storeId),
        // The storefront shows storeInfo.storeName: one name for the store everywhere (P.11)
        {
          Update: {
            TableName: DEFAULT_TABLE_NAME,
            Key: {
              pk: `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}`,
              sk: appConstants.DYNAMO_ENTITY_SETTINGS,
            },
            ConditionExpression: "attribute_exists(pk)",
            UpdateExpression: "SET #storeInfo.#storeName = :storeName",
            ExpressionAttributeNames: { "#storeInfo": "storeInfo", "#storeName": "storeName" },
            ExpressionAttributeValues: { ":storeName": storeName },
          },
        },
      ];
      // Release the old slug only if it's ours (before the backfill, or for stores that shared a
      // slug, it may be unreserved or held by another store). Once released, anyone may take it:
      // old links stop working (owner, 2026-11-13, P.11).
      if (oldSlug && oldSlug !== storeSlug && (await getSlugOwner(oldSlug)) === storeId) {
        transactItems.push(releaseSlugDelete(oldSlug, storeId));
      }

      try {
        await dynamoDbDocumentClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
      } catch (e) {
        if (transactionFailedAt(e, 1)) throw new SlugTakenError(storeSlug);
        if (transactionFailedAt(e, 2)) throw new StoreRecordNotFoundError("Store");
        if (transactionFailedAt(e, 0) || transactionFailedAt(e, 3)) continue; // changed under us
        throw e;
      }

      const { pk: _pk, sk: _sk, ...rest } = current.Item;
      const record = { ...rest, storeName, storeSlug } as StoreOverview;
      record.storeOrderLastCompletedDateStr =
        record.storeOrderLastCompletedTimestamp <= 0
          ? appConstants.NA
          : formatEpochToFullReadableDate(record.storeOrderLastCompletedTimestamp, true);
      return { ...initStore(storeId, storeName, storeSlug), ...record };
    }
    throw new Error("Store info changed while saving; gave up after 3 tries");
  } catch (e) {
    if (!(e instanceof SlugTakenError) && !(e instanceof StoreRecordNotFoundError)) {
      console.error("In updateStoreInfo", e);
    }
    throw e;
  }
}
