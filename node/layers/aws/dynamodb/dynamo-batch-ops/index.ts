// AWS
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, BatchWriteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../constants";

// Initialize DynamoDB Document Client
const dynamoDbDocumentClient: DynamoDBDocumentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({
        region: appConstants.DEFAULT_REGION,
    })
);

type WriteRequest = NonNullable<
    NonNullable<ConstructorParameters<typeof BatchWriteCommand>[0]["RequestItems"]>[string]
>[number];
type Key = Record<string, unknown>;
type Item = Record<string, unknown>;

// DynamoDB limits per request
const WRITE_BATCH_SIZE = 25;
const GET_BATCH_SIZE = 100;

/* Retry policy for items DynamoDB leaves unprocessed (throttling). Exported so tests can skip the waits. */
export const batchRetry = {
    maxAttempts: 8,
    baseDelayMs: 50, // 50, 100, 200, … 3200 ms between attempts
};

/* Thrown when a batch can't be fully written or read. Callers must treat the operation as failed. */
export class DynamoBatchError extends Error {
    readonly cause?: unknown;

    constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = "DynamoBatchError";
        this.cause = options?.cause;
    }
}

function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
}

function requireTable(tableName: string | undefined): string {
    if (!tableName) {
        throw new DynamoBatchError("No table name given");
    }
    return tableName;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/*
* Write up to 25 requests, retrying unprocessed ones with exponential backoff.
* Throws DynamoBatchError if any are still unprocessed after the last attempt.
*/
export async function dynamoWriteBatch(table: string | undefined, requestItems: WriteRequest[]): Promise<void> {
    const tableName = requireTable(table);
    let pending = requestItems;
    for (let attempt = 1; pending.length > 0; attempt++) {
        let res;
        try {
            res = await dynamoDbDocumentClient.send(
                new BatchWriteCommand({ RequestItems: { [tableName]: pending } })
            );
        } catch (e) {
            throw new DynamoBatchError("Batch write failed", { cause: e });
        }
        pending = res.UnprocessedItems?.[tableName] ?? [];
        if (pending.length === 0) {
            return;
        }
        if (attempt >= batchRetry.maxAttempts) {
            throw new DynamoBatchError(
                `Batch write left ${pending.length} item(s) unprocessed after ${attempt} attempts`
            );
        }
        console.warn(`dynamoWriteBatch: ${pending.length} unprocessed, retry ${attempt}`);
        await sleep(batchRetry.baseDelayMs * 2 ** (attempt - 1));
    }
}

/*
* Write any number of requests in batches of 25. Throws if any batch fails.
* Not atomic: batches that succeeded before a failure stay written.
*/
export async function dynamoWriteManyItems(table: string | undefined, requestItems: WriteRequest[]): Promise<void> {
    requireTable(table);
    const results = await Promise.allSettled(
        chunk(requestItems, WRITE_BATCH_SIZE).map((batch) => dynamoWriteBatch(table, batch))
    );
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length > 0) {
        failed.forEach((r) => console.error("In dynamoWriteManyItems", r.reason));
        throw new DynamoBatchError(`${failed.length} of ${results.length} write batch(es) failed`, {
            cause: failed[0].reason,
        });
    }
}

/*
* Read up to 100 keys, retrying unprocessed keys. Returns the items found (missing keys are
* simply absent). Throws DynamoBatchError if keys are still unprocessed after the last attempt.
*/
export async function dynamoGetBatch(table: string | undefined, keys: Key[]): Promise<Item[]> {
    const tableName = requireTable(table);
    const items: Item[] = [];
    let pending = keys;
    for (let attempt = 1; pending.length > 0; attempt++) {
        let res;
        try {
            res = await dynamoDbDocumentClient.send(
                new BatchGetCommand({ RequestItems: { [tableName]: { Keys: pending } } })
            );
        } catch (e) {
            throw new DynamoBatchError("Batch get failed", { cause: e });
        }
        items.push(...(res.Responses?.[tableName] ?? []));
        pending = res.UnprocessedKeys?.[tableName]?.Keys ?? [];
        if (pending.length === 0) {
            break;
        }
        if (attempt >= batchRetry.maxAttempts) {
            throw new DynamoBatchError(
                `Batch get left ${pending.length} key(s) unprocessed after ${attempt} attempts`
            );
        }
        await sleep(batchRetry.baseDelayMs * 2 ** (attempt - 1));
    }
    return items;
}

/*
* Read any number of keys in batches of 100 and return every item found, from all batches.
*/
export async function dynamGetManyItems(table: string | undefined, keys: Key[]): Promise<Item[]> {
    requireTable(table);
    const batches = await Promise.all(
        chunk(keys, GET_BATCH_SIZE).map((batch) => dynamoGetBatch(table, batch))
    );
    return batches.flat();
}
