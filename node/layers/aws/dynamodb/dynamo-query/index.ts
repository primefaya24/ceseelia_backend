import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../constants";
import { DB_TABLE_NAME } from "../../../../config";

const dynamoDbDocumentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: appConstants.DEFAULT_REGION })
);

/* Every row in the `pk` partition, following every page. */
export async function queryAllInPartition(
  pk: string,
  tableName: string | undefined = DB_TABLE_NAME
): Promise<Record<string, any>[]> {
  const records: Record<string, any>[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const result = await dynamoDbDocumentClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":pk": pk },
        ExclusiveStartKey,
      })
    );
    records.push(...(result.Items ?? []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return records;
}

/*
 * Every row under `pk` whose sort key starts with `skPrefix`. A query returns at most 1 MB, so
 * keep following LastEvaluatedKey until there are no more pages.
 */
export async function queryAllWithPrefix(
  pk: string,
  skPrefix: string,
  tableName: string | undefined = DB_TABLE_NAME
): Promise<Record<string, any>[]> {
  const records: Record<string, any>[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const result = await dynamoDbDocumentClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "#pk = :pk and begins_with(#sk, :sk_prefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: { ":pk": pk, ":sk_prefix": skPrefix },
        ExclusiveStartKey,
      })
    );
    records.push(...(result.Items ?? []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return records;
}
