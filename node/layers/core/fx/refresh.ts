/*
 * T.4a: the day's exchange rates. One row, `APP_FX / LATEST` ({ date, rates, fetchedAt }), filled
 * from the European Central Bank's daily reference rates through Frankfurter (free, no key). The
 * server loads the row when it starts, then `refreshFxRates` runs every few hours: it fetches when
 * the row is over 12 hours old, writes it, and keeps the rates in memory. On a failure the last
 * rates stay in use; past 3 days old it logs an error (CloudWatch alarm on API errors, Z1).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../constants";
import { DB_TABLE_NAME } from "../../../config";
import { CURRENCY_CODES } from "../../../constants/input-limits";
import { log } from "../logger";
import { FxRates, isFxRates, setFxRates } from ".";

export const FX_KEY = { pk: "APP_FX", sk: "LATEST" } as const;
export const FX_SOURCE_URL = `https://api.frankfurter.dev/v1/latest?base=USD&symbols=${CURRENCY_CODES.filter((c) => c !== "USD").join(",")}`;
const REFETCH_AFTER_MS = 12 * 60 * 60 * 1000;
const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: appConstants.DEFAULT_REGION }));

interface FxRow extends FxRates {
  fetchedAt: number;
}

/** Rates from the source, or null when it fails or answers something unexpected. */
export async function fetchFxRates(fetchFn: typeof fetch = fetch): Promise<FxRates | null> {
  try {
    const res = await fetchFn(FX_SOURCE_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { base?: string; date?: string; rates?: Record<string, number> };
    const rates: FxRates = { date: String(body.date ?? ""), rates: { ...(body.rates ?? {}), USD: 1 } };
    return body.base === "USD" && isFxRates(rates) ? rates : null;
  } catch {
    return null;
  }
}

async function readRow(): Promise<FxRow | null> {
  const res = await ddb.send(new GetCommand({ TableName: DB_TABLE_NAME, Key: FX_KEY }));
  const row = res.Item as FxRow | undefined;
  return row && isFxRates(row) && typeof row.fetchedAt === "number" ? row : null;
}

/**
 * Load the stored rates, fetch fresh ones when they're old or missing, and keep them in memory.
 * Never throws. Returns what's in use afterwards.
 */
export async function refreshFxRates(now = Date.now(), fetchFn: typeof fetch = fetch): Promise<FxRates | null> {
  let row: FxRow | null = null;
  try {
    row = await readRow();
  } catch (e) {
    log.warn({ err: e }, "[fx] rates row not read");
  }
  if (row) setFxRates({ date: row.date, rates: row.rates });
  if (row && now - row.fetchedAt < REFETCH_AFTER_MS) return row;

  const fresh = await fetchFxRates(fetchFn);
  if (fresh) {
    setFxRates(fresh);
    try {
      await ddb.send(
        new PutCommand({ TableName: DB_TABLE_NAME, Item: { ...FX_KEY, ...fresh, fetchedAt: now } })
      );
    } catch (e) {
      log.warn({ err: e }, "[fx] rates not saved");
    }
    log.info({ date: fresh.date }, "[fx] rates updated");
    return fresh;
  }
  if (!row || now - row.fetchedAt > STALE_AFTER_MS) {
    log.error({ fetchedAt: row?.fetchedAt ?? null }, "[fx] exchange rates are missing or over 3 days old");
  } else {
    log.warn("[fx] rates not fetched; the last ones stay in use");
  }
  return row;
}
