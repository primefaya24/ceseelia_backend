import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../../constants";
import { DB_TABLE_NAME } from "../../../../../config";
import { queryAllInPartition } from "../../dynamo-query";
import { CustomDomainReason, CustomDomainStatus } from "../../../../core/custom-domain";

/*
 * Stores' own domains (9.8 phase 2). One domain per store, three rows written together:
 *   STORE#<id>      / DOMAIN            the record (status, tenant, timestamps); goes with the store
 *   DOMAIN#<host>   / DOMAIN            {storeId}: a host belongs to one store (like slugs)
 *   APP_DOMAIN      / STORE#<id>        {storeId, host, status}: the sweep's and the live list
 * Removing a domain deletes the three and queues its CloudFront tenant for clean-up:
 *   APP_DOMAIN_CLEANUP / <tenantId>     {tenantId, certificateArn}
 * (a tenant must be disabled and deployed before it can be deleted, so that takes a few sweeps).
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: appConstants.DEFAULT_REGION }));

export const DOMAIN_SK = "DOMAIN";
export const DOMAIN_INDEX_PK = "APP_DOMAIN";
export const DOMAIN_CLEANUP_PK = "APP_DOMAIN_CLEANUP";

export interface StoreDomain {
  storeId: string;
  host: string;
  status: CustomDomainStatus;
  reason: CustomDomainReason | null;
  /** What the last DNS check saw (CNAME targets), for "it points to X instead". */
  dnsSeen: string[];
  tenantId: string | null;
  tenantName: string | null;
  certificateArn: string | null;
  createdAt: number;
  /** When the current wait (DNS or certificate) started. */
  stepAt: number;
  checkedAt: number;
  activeAt: number | null;
  disabledAt: number | null;
  updatedAt: number;
}

export class DomainTakenError extends Error {
  constructor() {
    super("That domain is already used by another store.");
    this.name = "DomainTakenError";
  }
}
export class StoreHasDomainError extends Error {
  constructor() {
    super("This store already has a domain. Remove it first.");
    this.name = "StoreHasDomainError";
  }
}

export const domainKey = (storeId: string) => ({ pk: `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}`, sk: DOMAIN_SK });
export const hostKey = (host: string) => ({ pk: `DOMAIN#${host}`, sk: DOMAIN_SK });
export const indexKey = (storeId: string) => ({ pk: DOMAIN_INDEX_PK, sk: `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}` });

function toDomain(item: Record<string, any>): StoreDomain {
  return {
    storeId: String(item.storeId),
    host: String(item.host),
    status: item.status as CustomDomainStatus,
    reason: (item.reason as CustomDomainReason) ?? null,
    dnsSeen: Array.isArray(item.dnsSeen) ? item.dnsSeen.map(String) : [],
    tenantId: item.tenantId ?? null,
    tenantName: item.tenantName ?? null,
    certificateArn: item.certificateArn ?? null,
    createdAt: Number(item.createdAt ?? 0),
    stepAt: Number(item.stepAt ?? item.createdAt ?? 0),
    checkedAt: Number(item.checkedAt ?? 0),
    activeAt: item.activeAt ?? null,
    disabledAt: item.disabledAt ?? null,
    updatedAt: Number(item.updatedAt ?? 0),
  };
}

export async function getStoreDomain(storeId: string): Promise<StoreDomain | null> {
  const r = await ddb.send(new GetCommand({ TableName: DB_TABLE_NAME, Key: domainKey(storeId), ConsistentRead: true }));
  return r.Item ? toDomain(r.Item) : null;
}

/** The store using a host (any status), or null. */
export async function getHostOwner(host: string): Promise<string | null> {
  const r = await ddb.send(new GetCommand({ TableName: DB_TABLE_NAME, Key: hostKey(host), ConsistentRead: true }));
  return (r.Item?.storeId as string | undefined) ?? null;
}

/** Every store domain (the sweep and the live list): small, one row per store with a domain. */
export async function listDomainIndex(): Promise<{ storeId: string; host: string; status: CustomDomainStatus }[]> {
  const rows = await queryAllInPartition(DOMAIN_INDEX_PK, DB_TABLE_NAME);
  return rows.map((r) => ({ storeId: String(r.storeId), host: String(r.host), status: r.status as CustomDomainStatus }));
}

/** A new domain, waiting for its CNAME. Throws DomainTakenError / StoreHasDomainError. */
export async function createStoreDomain(storeId: string, host: string, now: number): Promise<StoreDomain> {
  const domain: StoreDomain = {
    storeId,
    host,
    status: "PENDING_DNS",
    reason: "DNS_NOT_FOUND",
    dnsSeen: [],
    tenantId: null,
    tenantName: null,
    certificateArn: null,
    createdAt: now,
    stepAt: now,
    checkedAt: 0,
    activeAt: null,
    disabledAt: null,
    updatedAt: now,
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: DB_TABLE_NAME,
              Item: { ...domainKey(storeId), ...domain },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: DB_TABLE_NAME,
              Item: { ...hostKey(host), storeId, createdAt: now },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          { Put: { TableName: DB_TABLE_NAME, Item: { ...indexKey(storeId), storeId, host, status: domain.status } } },
        ],
      })
    );
  } catch (e) {
    const err = e as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
    if (err?.name === "TransactionCanceledException") {
      if (err.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed") throw new StoreHasDomainError();
      if (err.CancellationReasons?.[1]?.Code === "ConditionalCheckFailed") throw new DomainTakenError();
    }
    throw e;
  }
  return domain;
}

/**
 * Save a domain's new state (the record and its index row together), only while the record is
 * still the one read (`updatedAt`): a remove or another sweep in between wins. Returns false then.
 */
export async function saveStoreDomain(prev: StoreDomain, next: StoreDomain): Promise<boolean> {
  const { storeId } = next;
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: DB_TABLE_NAME,
              Item: { ...domainKey(storeId), ...next },
              ConditionExpression: "updatedAt = :was",
              ExpressionAttributeValues: { ":was": prev.updatedAt },
            },
          },
          {
            Update: {
              TableName: DB_TABLE_NAME,
              Key: indexKey(storeId),
              UpdateExpression: "SET #s = :s, host = :h, storeId = :id",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":s": next.status, ":h": next.host, ":id": storeId },
            },
          },
        ],
      })
    );
    return true;
  } catch (e) {
    if ((e as { name?: string })?.name === "TransactionCanceledException") return false;
    throw e;
  }
}

/** Delete a store's domain rows and queue its tenant (if any) for clean-up. */
export async function removeStoreDomain(domain: StoreDomain, now: number): Promise<void> {
  if (domain.tenantId) await queueTenantCleanup(domain.tenantId, domain.certificateArn, now);
  await Promise.all([
    ddb.send(new DeleteCommand({ TableName: DB_TABLE_NAME, Key: domainKey(domain.storeId) })),
    ddb.send(
      new DeleteCommand({
        TableName: DB_TABLE_NAME,
        Key: hostKey(domain.host),
        ConditionExpression: "attribute_not_exists(pk) OR storeId = :id",
        ExpressionAttributeValues: { ":id": domain.storeId },
      })
    ).catch((e) => {
      if ((e as { name?: string })?.name !== "ConditionalCheckFailedException") throw e;
    }),
    ddb.send(new DeleteCommand({ TableName: DB_TABLE_NAME, Key: indexKey(domain.storeId) })),
  ]);
}

export async function queueTenantCleanup(tenantId: string, certificateArn: string | null, now: number): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: DB_TABLE_NAME,
      Item: { pk: DOMAIN_CLEANUP_PK, sk: tenantId, tenantId, certificateArn, createdAt: now },
    })
  );
}

export interface TenantCleanup {
  tenantId: string;
  certificateArn: string | null;
  createdAt: number;
}

export async function listTenantCleanups(): Promise<TenantCleanup[]> {
  const rows = await queryAllInPartition(DOMAIN_CLEANUP_PK, DB_TABLE_NAME);
  return rows.map((r) => ({ tenantId: String(r.tenantId), certificateArn: r.certificateArn ?? null, createdAt: Number(r.createdAt ?? 0) }));
}

export async function setCleanupCertificate(tenantId: string, certificateArn: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: DB_TABLE_NAME,
      Key: { pk: DOMAIN_CLEANUP_PK, sk: tenantId },
      UpdateExpression: "SET certificateArn = :a",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":a": certificateArn },
    })
  );
}

export async function finishTenantCleanup(tenantId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: DB_TABLE_NAME, Key: { pk: DOMAIN_CLEANUP_PK, sk: tenantId } }));
}

export const _keys = { domainKey, hostKey, indexKey };
