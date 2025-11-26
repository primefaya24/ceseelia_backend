// AWS
import {DynamoDBClient} from "@aws-sdk/client-dynamodb";
import {BatchGetCommand, BatchWriteCommand, DynamoDBDocumentClient,} from "@aws-sdk/lib-dynamodb";
import {appConstants} from "../../../../constants";

// Initialize DynamoDB Document Client
const dynamoDbDocumentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({
        region: appConstants.DEFAULT_REGION,
    })
);

// Constants
const maxTry: number = 7;
const expBase: number = 2; // Exponential backoff: 50, 100, 200, 400, 800, 1600, 3200, 6400

/*
* Helper function: Write a batch to dynamodb
*/
export async function dynamoWriteBatch(tableName: any, requestItems: any): Promise<any> {
    try {
        // Prepare batch
        let batchParams: any = {
            RequestItems: {}
        };
        batchParams["RequestItems"][tableName] = requestItems;
        let unprocessedItems = batchParams;
        let batchWriteRes;
        let unprocessedItemsCount = unprocessedItems["RequestItems"][tableName].length;
        let tryBalance = 1;
        let backoffTime = 50; // ms

        // Submit batch
        let command;
        while (unprocessedItemsCount > 0 && tryBalance <= maxTry) {
            command = new BatchWriteCommand(unprocessedItems);
            batchWriteRes = await dynamoDbDocumentClient.send(command);
            unprocessedItems["RequestItems"] = batchWriteRes["UnprocessedItems"];

            // All requests processed
            if (typeof unprocessedItems["RequestItems"][tableName] === 'undefined') {
                unprocessedItemsCount = 0;
                console.warn("unprocessedItemsCount: " + unprocessedItemsCount + ", backoff: " + backoffTime);
            }

            // Some requests failed
            else {
                backoffTime = backoffTime * expBase;
                unprocessedItemsCount = unprocessedItems["RequestItems"][tableName].length;
                console.warn("unprocessedItemsCount: " + unprocessedItemsCount + ", backoff: " + backoffTime);
                await new Promise((resolve) => setTimeout(resolve, backoffTime));
            }

            tryBalance++;
        }

        // Return unprocessed items count
        return unprocessedItemsCount;
    } catch (e) {
        console.warn("In dynamoWriteBatch", e);
        throw "Could not write batch";
    }
}

/*
* Write a batch to dynamodb
*/
export async function dynamoWriteManyItems(tableName: any, requestItems: any): Promise<any> {
    try {
        // Build a matrix with dimension m x 25 (an array of 25-item batches)
        let batchesMatrix: any[] = [];
        for (let i = 0; i < requestItems.length; i++) {
            if (i % 25 === 0) {
                batchesMatrix.push([]);
            }
            batchesMatrix[batchesMatrix.length - 1].push(requestItems[i]);
        }

        // Build promises array (an array of batchWrite promises)
        let promises = [];
        for (let batch of batchesMatrix) {
            promises.push(
                new Promise((resolve, reject) => {
                    dynamoWriteBatch(tableName, batch)
                        .then((unprocessedItems) => resolve(unprocessedItems))
                        .catch((e) => {
                            console.error(e);
                            reject(e);
                        });
                })
            );
        }

        // Send all promises, wait for the last one to resolve/reject
        return await Promise.allSettled(promises);
    } catch (e) {
        console.warn("In dynamoWriteManyItems", e);
        throw "Could not write batch";
    }
}

/*
* Helper Function: Fetch a batch of items
*/
export async function dynamoGetBatch(tableName: any, requestItems: any): Promise<any> {
    try {
        const input: any = {
            RequestItems: {}
        };
        input["RequestItems"][tableName] = {
            "Keys": requestItems
        };
        const command = new BatchGetCommand(input);
        return await dynamoDbDocumentClient.send(command);
    } catch (e) {
        console.warn("In dynamoGetBatch", e);
        throw "Could not get batch";
    }
}

/*
* Get many items
*/
export async function dynamGetManyItems(tableName: any, requestItems: any): Promise<any> {
    try {
        // Build a matrix with dimension m x 25 (an array of 25-item batches)
        let batchesMatrix: any = [];
        for (let i = 0; i < requestItems.length; i++) {
            if (i % 25 === 0) {
                batchesMatrix.push([]);
            }
            batchesMatrix[batchesMatrix.length - 1].push(requestItems[i]);
        }

        // Build promises array (an array of batchWrite promises)
        let promises = [];
        for (let batch of batchesMatrix) {
            promises.push(
                new Promise((resolve, reject) => {
                    dynamoGetBatch(tableName, batch)
                        .then((items) => resolve(items))
                        .catch((e) => {
                            console.error(e);
                            reject(e);
                        });
                })
            );
        }

        // Send all promises, wait for the last one to resolve/reject
        const result: any = await Promise.allSettled(promises);
        return result.length > 0 ? result[0].value.Responses[tableName] : [];
    } catch (e) {
        console.warn("In dynamGetManyItems", e);
        throw "Could not get many items";
    }
}