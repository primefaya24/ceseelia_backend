import { Request, Response, Router } from "express";
import { validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { shopperCurrency } from "../../../../layers/core/http/public-storefront";

/*
 * GET /merchant/suggested-currency (any signed-in user, T.3b) → 200 { currencyCode }
 *
 * The currency for where the caller is (geo-IP: Canada CAD, US USD, Australia AUD, anywhere else
 * USD). The create-store forms prefill it; store creation uses the same rule when no currency is
 * sent.
 */
export default function registerRoute(router: Router): void {
  router.get("/suggested-currency", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(req, res, () => true, () => true, executeRouteCore, true, false);
  });
}

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  res.send({ currencyCode: shopperCurrency(req) });
}
