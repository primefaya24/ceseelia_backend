import { Request, Response, Router } from "express";
import { appConstants } from "../../../../constants";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { isUlid } from "../../../../layers/core/utils";
import { StoreStatusChangedError } from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import {
  getStoreAdminState,
  saveReviewDecision,
} from "../../../../layers/aws/dynamodb/dynamo-entities/store-admin";
import {
  lifecycleAfterReview,
  REVIEW_DECISIONS,
  REVIEW_MESSAGE_MAX,
  ReviewDecision,
} from "../../../../layers/core/review";
import { blocksNewSubscription } from "../../../../layers/core/billing";
import { cancelSubscriptionNow } from "../../../../layers/payments/billing";
import { sendPaymentsError } from "../../store/payments/errors";

/*
 * POST /admin/review-store { storeId, decision: "APPROVE" | "REJECT", message? } (admin, P.8)
 * → { status, plan, approved } where `approved` = a DRAFT cleared to go live (see
 *   layers/core/review: its next Go Live goes straight to checkout, or live on a gifted plan).
 * REJECT needs a message (1–500 characters), shown to the merchant.
 * 404 STORE_NOT_FOUND · 409 NOT_IN_REVIEW · 409 STATUS_CHANGED (someone decided meanwhile)
 * A rejected store that somehow has a paying subscription has it cancelled first (otherwise its
 * next payment would take it live again); 502 and nothing changes if Stripe can't be reached.
 */
export default function registerRoute(router: Router): void {
  router.post("/review-store", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, pureRequestParams, validRequestParams, executeRouteCore, true, /* admins only */ true);
  });
}

function pureRequestParams(req: Request): boolean {
  const { storeId, decision, message } = req.body;
  return isUlid(storeId) && typeof decision === "string" && (message === undefined || typeof message === "string");
}

function validRequestParams(req: Request): boolean {
  const { decision, message } = req.body;
  if (!(REVIEW_DECISIONS as readonly string[]).includes(decision)) return false;
  const m = typeof message === "string" ? message.trim() : "";
  if (m.length > REVIEW_MESSAGE_MAX) return false;
  return decision !== "REJECT" || m.length > 0;
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  try {
    const storeId = String(req.body.storeId);
    const decision = req.body.decision as ReviewDecision;
    const state = await getStoreAdminState(storeId);
    if (!state) {
      res.status(appConstants.HTTP_STATUS_CODE_NOT_FOUND).send({ code: "STORE_NOT_FOUND", message: "Store not found" });
      return;
    }
    if (state.lifecycle.status !== "IN_REVIEW") {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code: "NOT_IN_REVIEW", message: "This store isn't waiting for review." });
      return;
    }
    if (
      decision === "REJECT" &&
      state.subscription &&
      blocksNewSubscription(state.subscription, Date.now())
    ) {
      await cancelSubscriptionNow(state.subscription.subscriptionId);
    }
    const lifecycle = lifecycleAfterReview(state.lifecycle, decision, {
      now: Date.now(),
      message: req.body.message,
    });
    await saveReviewDecision(storeId, lifecycle);
    res.send({ status: lifecycle.status, plan: lifecycle.plan, approved: lifecycle.reviewApprovedAt !== undefined });
  } catch (e) {
    if (e instanceof StoreStatusChangedError) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({ code: "STATUS_CHANGED", message: "Someone else just decided. Reload." });
      return;
    }
    sendPaymentsError(e, res, "In review-store");
  }
}
