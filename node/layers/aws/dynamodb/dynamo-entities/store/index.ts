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
    const storeOverview: StoreOverview = initStore(storeId, storeName, storeSlug);
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
