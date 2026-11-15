import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { appConstants } from "../../../../../constants";
import { DB_TABLE_NAME } from "../../../../../config";
import { StoreOrder } from "../../../../core/interfaces/store";

/*
 * Store reviews (progress.md L.7 / 7.5; rules set by the owner 2026-11-15):
 *   - Only a verified buyer reviews: the order's own token (checkout or order email), one review
 *     per order, once the order is ready, shipped or completed (or 14 days after payment).
 *   - A review is live at once. Nobody edits it. The merchant may reply (and change the reply)
 *     and may report it; only a platform admin removes it (KEEP or REMOVE on the report).
 *
 *   `STORE#<id> / REVIEW#<createdAt 13>#<orderId>`  the review (newest first by sort key)
 *   `STORE#<id> / REVIEW_FOR#<orderId>`              { reviewSk } one per order (conditional)
 *   `STORE#<id> / REVIEW_STATS`                      { count, sum, r1..r5 } published reviews
 *   `APP_REVIEW_REPORT / STORE#<id>#REVIEW#<orderId>` the admin queue (open reports only)
 * Every change to what's published moves the stats in the same transaction.
 */
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: appConstants.DEFAULT_REGION }));
const TABLE = DB_TABLE_NAME;

export const REVIEW = "REVIEW";
export const REVIEW_PAGE = 20;
export const REVIEW_AFTER_PAID_MS = 14 * 24 * 3600 * 1000;
export const REVIEW_SK_PATTERN = /^REVIEW#\d{13}#[0-9A-HJKMNP-TV-Z]{26}$/;
export const REPORT_QUEUE_PK = "APP_REVIEW_REPORT";
export const REPORT_REASONS = ["OFFENSIVE", "PERSONAL_INFO", "SPAM", "OTHER"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

const storePk = (storeId: string) => `${appConstants.DYNAMO_ENTITY_STORE}#${storeId}`;
const pad = (ms: number) => String(Math.max(0, Math.floor(ms))).padStart(13, "0");
const markerKey = (storeId: string, orderId: string) => ({ pk: storePk(storeId), sk: `REVIEW_FOR#${orderId}` });
const statsKey = (storeId: string) => ({ pk: storePk(storeId), sk: "REVIEW_STATS" });
const queueKey = (storeId: string, orderId: string) => ({ pk: REPORT_QUEUE_PK, sk: `STORE#${storeId}#REVIEW#${orderId}` });

export interface ReviewReport {
  reason: ReportReason;
  note: string;
  at: number;
  byUserId: string;
  status: "OPEN" | "KEPT" | "REMOVED";
  decidedAt?: number;
}

export interface StoreReview {
  storeId: string;
  orderId: string;
  rating: number;
  comment: string;
  /** "Ann L." from the order's name; "Verified buyer" if it had none. */
  authorName: string;
  /** What they bought (item names, ≤ 5), shown as "Bought: …". */
  items: string[];
  createdAt: number;
  status: "PUBLISHED" | "REMOVED";
  removedAt?: number;
  reply?: { text: string; at: number };
  report?: ReviewReport;
}

export interface ReviewStats {
  count: number;
  average: number | null;
  /** Count per star, index 0 = 1 star. */
  distribution: number[];
}

/** First name and last initial; nothing else from the order is shown. */
export function reviewAuthorName(fullName: string | undefined): string {
  const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Verified buyer";
  const first = parts[0].slice(0, 30);
  return parts.length > 1 ? `${first} ${parts[parts.length - 1][0].toUpperCase()}.` : first;
}

/** Plain text: no control characters, at most one blank line in a row, trimmed. */
export function cleanReviewText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type ReviewableState = "OK" | "NOT_YET" | "NOT_REVIEWABLE";

/** Can this order be reviewed now? (Whether it already has a review is checked separately.) */
export function reviewableState(order: StoreOrder, now: number): ReviewableState {
  const s = order.storeOrderStatus;
  if (s === "PENDING_PAYMENT" || s === "CANCELLED" || s === "REFUNDED") return "NOT_REVIEWABLE";
  if (s === "READY" || s === "SHIPPED" || s === "COMPLETED") return "OK";
  return typeof order.storeOrderPaidAt === "number" && now - order.storeOrderPaidAt >= REVIEW_AFTER_PAID_MS ? "OK" : "NOT_YET";
}

function fromRow(row: Record<string, unknown>): StoreReview {
  const { pk: _pk, sk: _sk, ...rest } = row;
  return rest as unknown as StoreReview;
}

export function statsFromRow(row: Record<string, unknown> | undefined): ReviewStats {
  const count = Math.max(0, Number(row?.count ?? 0));
  const sum = Number(row?.sum ?? 0);
  return {
    count,
    average: count ? Math.round((sum / count) * 10) / 10 : null,
    distribution: [1, 2, 3, 4, 5].map((n) => Math.max(0, Number(row?.[`r${n}`] ?? 0))),
  };
}

export async function getReviewStats(storeId: string): Promise<ReviewStats> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: statsKey(storeId) }));
  return statsFromRow(res.Item);
}

export async function getReviewForOrder(storeId: string, orderId: string): Promise<{ review: StoreReview; sk: string } | null> {
  const marker = (await ddb.send(new GetCommand({ TableName: TABLE, Key: markerKey(storeId, orderId), ConsistentRead: true }))).Item;
  if (!marker?.reviewSk) return null;
  const row = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: storePk(storeId), sk: String(marker.reviewSk) }, ConsistentRead: true }))).Item;
  return row ? { review: fromRow(row), sk: String(marker.reviewSk) } : null;
}

const statsMove = (storeId: string, rating: number, by: 1 | -1) => ({
  Update: {
    TableName: TABLE,
    Key: statsKey(storeId),
    UpdateExpression: "ADD #count :n, #sum :s, #r :n",
    ExpressionAttributeNames: { "#count": "count", "#sum": "sum", "#r": `r${rating}` },
    ExpressionAttributeValues: { ":n": by, ":s": by * rating },
  },
});

export class ReviewExistsError extends Error {}

/** Writes the review (live at once). Throws ReviewExistsError if the order already has one. */
export async function createReview(order: StoreOrder, rating: number, comment: string, now: number): Promise<StoreReview> {
  const sk = `${REVIEW}#${pad(now)}#${order.storeOrderId}`;
  const review: StoreReview = {
    storeId: order.storeId,
    orderId: order.storeOrderId,
    rating,
    comment,
    authorName: reviewAuthorName(order.storeOrderCustomer?.name),
    items: [...new Set((order.storeOrderLines ?? []).map((l) => l.itemName))].slice(0, 5),
    createdAt: now,
    status: "PUBLISHED",
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: { ...markerKey(order.storeId, order.storeOrderId), reviewSk: sk, createdAt: now },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          { Put: { TableName: TABLE, Item: { pk: storePk(order.storeId), sk, ...review } } },
          statsMove(order.storeId, rating, 1),
        ],
      })
    );
  } catch (e) {
    if ((e as { name?: string }).name === "TransactionCanceledException") throw new ReviewExistsError("This order already has a review");
    throw e;
  }
  return review;
}

/** A page of the store's reviews, newest first. `publishedOnly` for shoppers. */
export async function listReviews(
  storeId: string,
  opts: { cursor?: string; publishedOnly: boolean; limit?: number }
): Promise<{ reviews: StoreReview[]; next: string | null }> {
  const limit = opts.limit ?? REVIEW_PAGE;
  const out: StoreReview[] = [];
  let start: Record<string, unknown> | undefined = opts.cursor ? { pk: storePk(storeId), sk: opts.cursor } : undefined;
  for (let round = 0; round < 5 && out.length < limit; round++) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)",
        ...(opts.publishedOnly
          ? { FilterExpression: "#st = :pub", ExpressionAttributeNames: { "#st": "status" } }
          : {}),
        ExpressionAttributeValues: { ":pk": storePk(storeId), ":p": `${REVIEW}#`, ...(opts.publishedOnly ? { ":pub": "PUBLISHED" } : {}) },
        ScanIndexForward: false,
        Limit: 50,
        ...(start ? { ExclusiveStartKey: start } : {}),
      })
    );
    for (const row of res.Items ?? []) {
      if (out.length >= limit) return { reviews: out, next: `${REVIEW}#${pad(out[out.length - 1].createdAt)}#${out[out.length - 1].orderId}` };
      out.push(fromRow(row));
    }
    start = res.LastEvaluatedKey;
    if (!start) return { reviews: out, next: null };
  }
  return { reviews: out, next: (start?.sk as string) ?? null };
}

/** The merchant's public reply; an empty text removes it. Only on a published review. */
export async function setReviewReply(storeId: string, sk: string, text: string, now: number): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: storePk(storeId), sk },
        ...(text
          ? { UpdateExpression: "SET #reply = :r", ExpressionAttributeValues: { ":r": { text, at: now }, ":pub": "PUBLISHED" } }
          : { UpdateExpression: "REMOVE #reply", ExpressionAttributeValues: { ":pub": "PUBLISHED" } }),
        ConditionExpression: "attribute_exists(pk) AND #st = :pub",
        ExpressionAttributeNames: { "#reply": "reply", "#st": "status" },
      })
    );
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

export class ReportRefusedError extends Error {}

/** The merchant reports a review: the review keeps showing until an admin decides. Once per review. */
export async function reportReview(
  review: StoreReview,
  sk: string,
  report: { reason: ReportReason; note: string; byUserId: string },
  storeName: string,
  now: number
): Promise<ReviewReport> {
  const r: ReviewReport = { ...report, at: now, status: "OPEN" };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { pk: storePk(review.storeId), sk },
              UpdateExpression: "SET #report = :r",
              ConditionExpression: "attribute_exists(pk) AND #st = :pub AND attribute_not_exists(#report)",
              ExpressionAttributeNames: { "#report": "report", "#st": "status" },
              ExpressionAttributeValues: { ":r": r, ":pub": "PUBLISHED" },
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: {
                ...queueKey(review.storeId, review.orderId),
                storeId: review.storeId,
                orderId: review.orderId,
                reviewSk: sk,
                storeName,
                rating: review.rating,
                comment: review.comment,
                authorName: review.authorName,
                reviewCreatedAt: review.createdAt,
                reply: review.reply ?? null,
                reason: r.reason,
                note: r.note,
                reportedAt: now,
              },
            },
          },
        ],
      })
    );
  } catch (e) {
    if ((e as { name?: string }).name === "TransactionCanceledException") throw new ReportRefusedError("Already reported, or no longer shown");
    throw e;
  }
  return r;
}

export interface ReviewReportQueueRow {
  storeId: string;
  orderId: string;
  storeName: string;
  rating: number;
  comment: string;
  authorName: string;
  reviewCreatedAt: number;
  reply: { text: string; at: number } | null;
  reason: ReportReason;
  note: string;
  reportedAt: number;
}

/** Open reports, oldest first (the order they came in). */
export async function listReviewReports(): Promise<ReviewReportQueueRow[]> {
  const out: ReviewReportQueueRow[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": REPORT_QUEUE_PK },
        ...(start ? { ExclusiveStartKey: start } : {}),
      })
    );
    for (const { pk: _pk, sk: _sk, reviewSk: _r, ...row } of res.Items ?? []) out.push(row as ReviewReportQueueRow);
    start = res.LastEvaluatedKey;
  } while (start && out.length < 1000);
  return out.sort((a, b) => a.reportedAt - b.reportedAt);
}

export class ReportChangedError extends Error {}

/** An admin's decision. KEEP: the review stays (and can't be reported again). REMOVE: hidden, out of the stats. */
export async function decideReviewReport(storeId: string, orderId: string, decision: "KEEP" | "REMOVE", now: number): Promise<void> {
  const found = await getReviewForOrder(storeId, orderId);
  if (!found || found.review.report?.status !== "OPEN") throw new ReportChangedError("No open report on this review");
  const { review, sk } = found;
  const reviewKey = { pk: storePk(storeId), sk };
  const open = {
    ConditionExpression: "#report.#rs = :open AND #st = :pub",
    ExpressionAttributeNames: { "#report": "report", "#rs": "status", "#st": "status" },
  };
  const update =
    decision === "KEEP"
      ? {
          Update: {
            TableName: TABLE,
            Key: reviewKey,
            UpdateExpression: "SET #report.#rs = :kept, #report.decidedAt = :now",
            ...open,
            ExpressionAttributeValues: { ":kept": "KEPT", ":now": now, ":open": "OPEN", ":pub": "PUBLISHED" },
          },
        }
      : {
          Update: {
            TableName: TABLE,
            Key: reviewKey,
            UpdateExpression: "SET #st = :removed, removedAt = :now, #report.#rs = :removed, #report.decidedAt = :now",
            ...open,
            ExpressionAttributeValues: { ":removed": "REMOVED", ":now": now, ":open": "OPEN", ":pub": "PUBLISHED" },
          },
        };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          update,
          { Delete: { TableName: TABLE, Key: queueKey(storeId, orderId) } },
          ...(decision === "REMOVE" ? [statsMove(storeId, review.rating, -1)] : []),
        ],
      })
    );
  } catch (e) {
    if ((e as { name?: string }).name === "TransactionCanceledException") throw new ReportChangedError("The report changed; reload");
    throw e;
  }
}
