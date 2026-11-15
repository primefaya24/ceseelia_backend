import { Request, Response, Router } from "express";
import { appConstants } from "../../../../../constants";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../../layers/core/http";
import { CACHE_CONTROL, setCacheControl } from "../../../../../layers/core/http/cache";
import { listOrderAlertsSince } from "../../../../../layers/aws/dynamodb/dynamo-entities/order-alert";
import { log } from "../../../../../layers/core/logger";

/*
 * GET /store/orders/new/:storeId?since=<ms> (store members, progress.md L.5 / WA 6.4)
 *   → 200 { orders: OrderAlert[], now }
 *
 * The dashboard polls this for orders paid since it last looked (toast, sound, bell). `since` is
 * a `now` this route returned before; the webapp sends it back a minute early and skips ids it
 * has seen, so an alert written while a poll was running isn't missed. Without `since`, no
 * orders: just `now`, so a dashboard that opens doesn't announce old orders. Newest first, at
 * most 20; reads one store's alert rows (a week of them at most).
 */
export const NEW_ORDERS_MAX_LOOKBACK_MS = 24 * 3600 * 1000;

export default function registerRoute(router: Router): void {
  router.get("/new/:storeId", (req: Request, res: Response): void => {
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

function pureRequestParams(req: Request): boolean {
  return req.query.since === undefined || typeof req.query.since === "string";
}

function validRequestParams(req: Request): boolean {
  const since = req.query.since as string | undefined;
  return since === undefined || (/^\d{1,16}$/.test(since) && Number(since) <= 9_999_999_999_999);
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  setCacheControl(res, CACHE_CONTROL.none);
  const now = Date.now();
  const raw = req.query.since as string | undefined;
  if (raw === undefined) {
    res.send({ orders: [], now });
    return;
  }
  // A tab left asleep for days asks for a day at most (the bell isn't an order history).
  const since = Math.max(Number(raw), now - NEW_ORDERS_MAX_LOOKBACK_MS);
  try {
    const orders = await listOrderAlertsSince(String(req.params.storeId), since);
    res.send({ orders, now });
  } catch (e) {
    log.error({ err: e }, "In store/orders/new");
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
