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
  StoreOverview,
  StoreSettings,
} from "../../../../core/interfaces/store";
import { formatEpochToFullReadableDate } from "../../../../core/utils";

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
    let allStores: StoreOverview[] = [];
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

export async function updateStoreInfo(
  storeId: string,
  storeName: string,
  storeSlug: string
): Promise<StoreOverview> {
  try {
    const command = new UpdateCommand({
      TableName: DEFAULT_TABLE_NAME,
      Key: {
        pk: appConstants.DYNAMO_ENTITY_APP_STORE,
        sk:
          appConstants.DYNAMO_ENTITY_STORE +
          "#" +
          storeId +
          "#" +
          appConstants.DYNAMO_ENTITY_OVERVIEW,
      },
      ConditionExpression: "attribute_exists(pk) and attribute_exists(sk)",
      UpdateExpression: "set #storeName = :storeName, #storeSlug = :storeSlug",
      ExpressionAttributeNames: {
        "#storeName": "storeName",
        "#storeSlug": "storeSlug",
      },
      ExpressionAttributeValues: {
        ":storeName": storeName,
        ":storeSlug": storeSlug,
      },
      ReturnValues: "ALL_NEW",
    });
    const response = await dynamoDbDocumentClient.send(command);
    const record = response.Attributes;
    if (record) {
      delete record.pk;
      delete record.sk;

      record.storeOrderLastCompletedDateStr =
        record.storeOrderLastCompletedTimestamp <= 0
          ? appConstants.NA
          : formatEpochToFullReadableDate(
              record.storeOrderLastCompletedTimestamp,
              true
            );
    }
    return (
      (record as StoreOverview) ?? initStore(storeId, storeName, storeSlug)
    );
  } catch (e) {
    console.error("In updateStoreInfo", e);
    throw e;
  }
}
