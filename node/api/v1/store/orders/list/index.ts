import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../../layers/core/http/cache";
import {
  merchantOrderSummary,
  STORE_ORDER_STATUSES,
  StoreOrderStatus,
} from "../../../../../layers/core/interfaces/store";
import { listStoreOrders, ORDER_SK_PATTERN } from "../../../../../layers/aws/dynamodb/dynamo-entities/order";

/*
 * GET /store/orders/list/:storeId?status=PAID,PREPARING&from=<ms>&to=<ms>&cursor=<c>&limit=<n>
 * (store members, progress.md 6.1) → 200 { orders: MerchantOrderSummary[], next: string | null }
 *
 * Newest first. `status`: comma-separated; by default every status except PENDING_PAYMENT
 * (checkouts not paid yet aren't orders to the merchant; ask for them by name). `from` / `to`:
 * creation time, inclusive. `limit` 1–100 (default 25). `next` goes back as `cursor`.
 * 400 for an unknown status, a bad range or cursor.
 */
export const LIST_DEFAULT_LIMIT = 25;
export const LIST_MAX_LIMIT = 100;
const DEFAULT_STATUSES = STORE_ORDER_STATUSES.filter((s) => s !== "PENDING_PAYMENT");

export default function registerRoute(router: Router): void {
  router.get("/list/:storeId", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      pureRequestParams,
      validRequestParams,
      executeRouteCore,
      true,
      storeMember((req) => req.params.storeId)
    );
  });
}

const one = (v: unknown) => v === undefined || typeof v === "string";
const isMs = (v: unknown) => v === undefined || (/^\d{1,16}$/.test(String(v)) && Number(v) <= 9_999_999_999_999);

function pureRequestParams(req: Request): boolean {
  const q = req.query;
  return one(q.status) && one(q.from) && one(q.to) && one(q.cursor) && one(q.limit);
}

export function parseStatuses(raw: string | undefined): StoreOrderStatus[] | null {
  if (raw === undefined || raw === "") return [...DEFAULT_STATUSES];
  const list = [...new Set(raw.split(",").map((s) => s.trim().toUpperCase()))];
  return list.every((s) => (STORE_ORDER_STATUSES as readonly string[]).includes(s)) ? (list as StoreOrderStatus[]) : null;
}

function validRequestParams(req: Request): boolean {
  const q = req.query as Record<string, string | undefined>;
  if (!parseStatuses(q.status)) return false;
  if (!isMs(q.from) || !isMs(q.to)) return false;
  if (q.from !== undefined && q.to !== undefined && Number(q.from) > Number(q.to)) return false;
  if (q.cursor !== undefined && !ORDER_SK_PATTERN.test(q.cursor)) return false;
  if (q.limit !== undefined && !(/^\d{1,3}$/.test(q.limit) && +q.limit >= 1 && +q.limit <= LIST_MAX_LIMIT)) return false;
  return true;
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const q = req.query as Record<string, string | undefined>;
  try {
    const { orders, next } = await listStoreOrders(String(req.params.storeId), {
      statuses: parseStatuses(q.status)!,
      ...(q.from !== undefined ? { from: Number(q.from) } : {}),
      ...(q.to !== undefined ? { to: Number(q.to) } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
      limit: q.limit ? Number(q.limit) : LIST_DEFAULT_LIMIT,
    });
    res.send({ orders: orders.map(merchantOrderSummary), next });
  } catch (e) {
    console.error("In store/orders/list", e);
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
