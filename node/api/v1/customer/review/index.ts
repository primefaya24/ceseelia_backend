import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { MAX_LENGTH } from "../../../../constants/input-limits";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../layers/core/http/cache";
import { createRateLimiter } from "../../../../layers/core/http/rate-limit";
import { getClientIp, isUlid } from "../../../../layers/core/utils";
import { getOrderById, orderTokenMatches } from "../../../../layers/aws/dynamodb/dynamo-entities/order";
import {
  ReviewExistsError,
  StoreReview,
  cleanReviewText,
  createReview,
  getReviewForOrder,
  reviewableState,
} from "../../../../layers/aws/dynamodb/dynamo-entities/review";
import { log } from "../../../../layers/core/logger";

/*
 * Shopper reviews (progress.md L.7 / 7.5), verified by the order's token in `X-Order-Token`
 * (the checkout's, or one from an order email) like order-status: a wrong token = unknown order
 * = 404 ORDER_NOT_FOUND.
 *   GET  /customer/review/:orderId → { state: OK | NOT_YET | NOT_REVIEWABLE | REVIEWED, review|null }
 *   POST /customer/review { orderId, rating 1–5, comment ≤ 2,000 (may be empty) }
 *        → 201 { review }, live at once; 409 REVIEW_EXISTS / NOT_YET / NOT_REVIEWABLE.
 * Reviews can't be edited or deleted by anyone but a platform admin (owner's rule). Posting:
 * 10 per IP per 10 minutes.
 */
export const reviewPostLimit = createRateLimiter({ windowMs: 10 * 60_000, max: 10 });
export const reviewReadLimit = createRateLimiter({ windowMs: 60_000, max: 60 });

/** What a shopper (or anyone, on the storefront) sees of a review. */
export function publicReviewView(r: StoreReview) {
  return {
    rating: r.rating,
    comment: r.comment,
    authorName: r.authorName,
    items: r.items ?? [],
    createdAt: r.createdAt,
    reply: r.reply ?? null,
  };
}

export default function registerRoute(router: Router): void {
  router.get("/review/:orderId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, hasToken, (req) => isUlid(req.params.orderId), getCore, false);
  });
  router.post("/review", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, purePost, validPost, postCore, false);
  });
}

const hasToken = (req: Request) => typeof req.header("x-order-token") === "string";

function purePost(req: Request): boolean {
  const { orderId, rating, comment } = req.body ?? {};
  return hasToken(req) && typeof orderId === "string" && typeof rating === "number" && (comment === undefined || typeof comment === "string");
}

function validPost(req: Request): boolean {
  const { orderId, rating, comment } = req.body;
  return isUlid(orderId) && Number.isInteger(rating) && rating >= 1 && rating <= 5 && (comment ?? "").length <= MAX_LENGTH.reviewComment + 200;
}

function limited(res: Response, l: { ok: true } | { ok: false; retryAfterSeconds: number }): boolean {
  if (l.ok) return false;
  res.set("Retry-After", String(l.retryAfterSeconds));
  res.status(429).send({ code: "RATE_LIMITED", message: "Too many requests. Please try again shortly." });
  return true;
}

async function verifiedOrder(req: Request, res: Response, orderId: string) {
  const order = await getOrderById(orderId);
  if (!order || !orderTokenMatches(order, req.header("x-order-token") ?? "")) {
    res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "ORDER_NOT_FOUND", message: "Order not found" });
    return null;
  }
  return order;
}

const fail = (res: Response, where: string) => (e: unknown) => {
  log.error({ err: e }, where);
  res.status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR).send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
};

async function getCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  if (limited(res, reviewReadLimit.take(`ip:${getClientIp(req) ?? "unknown"}`))) return;
  try {
    const order = await verifiedOrder(req, res, String(req.params.orderId));
    if (!order) return;
    const found = await getReviewForOrder(order.storeId, order.storeOrderId);
    if (found) {
      // A review an admin removed is shown to its author as removed, not offered again.
      res.send({ state: "REVIEWED", removed: found.review.status === "REMOVED", review: publicReviewView(found.review) });
      return;
    }
    res.send({ state: reviewableState(order, Date.now()), removed: false, review: null });
  } catch (e) {
    fail(res, "In customer/review GET")(e);
  }
}

async function postCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  if (limited(res, reviewPostLimit.take(`ip:${getClientIp(req) ?? "unknown"}`))) return;
  const comment = cleanReviewText(String(req.body.comment ?? ""));
  if (comment.length > MAX_LENGTH.reviewComment) {
    res.status(appConstants.HTTP_STATUS_CODE_BAD_REQUEST).send({ code: "COMMENT_TOO_LONG", message: `At most ${MAX_LENGTH.reviewComment} characters` });
    return;
  }
  try {
    const order = await verifiedOrder(req, res, String(req.body.orderId));
    if (!order) return;
    const now = Date.now();
    const state = reviewableState(order, now);
    if (state !== "OK") {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({
        code: state,
        message: state === "NOT_YET" ? "You can review this order once it's ready or on its way." : "This order can't be reviewed.",
      });
      return;
    }
    const review = await createReview(order, req.body.rating, comment, now);
    log.info({ storeId: order.storeId, orderId: order.storeOrderId, rating: review.rating }, "Review posted");
    res.status(201).send({ review: publicReviewView(review) });
  } catch (e) {
    if (e instanceof ReviewExistsError) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code: "REVIEW_EXISTS", message: "You've already reviewed this order." });
      return;
    }
    fail(res, "In customer/review POST")(e);
  }
}
