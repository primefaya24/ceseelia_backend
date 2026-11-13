import { Request, Response, Router } from "express";
import { PLANS, STORE_PLANS, isPlanAvailable } from "../../../../../layers/core/plans";
import { CACHE_CONTROL, setCacheControl } from "../../../../../layers/core/http/cache";

/*
 * GET /store/public/plans (no auth, progress.md P.4) → { plans: [{ id, name, monthlyPriceMinor,
 * commissionMinor, monthlyOrderLimit, customDomain, available }] }, prices and commissions in
 * cents for every currency. The catalogue lives only in layers/core/plans; the webapp reads it
 * here (pricing, the plan & billing card), never from its own copy.
 */
export default function registerRoute(router: Router): void {
  router.get("/plans", (_req: Request, res: Response): void => {
    setCacheControl(res, CACHE_CONTROL.slug);
    res.send({
      plans: STORE_PLANS.map((id) => ({ ...PLANS[id], available: isPlanAvailable(id) })),
    });
  });
}
