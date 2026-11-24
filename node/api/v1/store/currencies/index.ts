import { Request, Response, Router } from "express";
import { storeMember, validateAndExecuteHttpApiRoute } from "../../../../layers/core/http";
import { createRateLimiter } from "../../../../layers/core/http/rate-limit";
import { appConstants } from "../../../../constants";
import { isUlid } from "../../../../layers/core/utils";
import { log } from "../../../../layers/core/logger";
import { isCurrencyCode } from "../../merchant/create-store";
import { currentFxRates, mainCurrency } from "../../../../layers/core/fx";
import {
  MAIN_CURRENCY_MODES,
  MainCurrencyMode,
  moveItemPrices,
  moveSettings,
  roundingFor,
} from "../../../../layers/core/fx/main-currency";
import {
  getStoreInventoryData,
  getStoreItem,
  updateItemParamsIfUnchanged,
  updateStoreCurrenciesIfUnchanged,
} from "../../../../layers/aws/dynamodb/dynamo-entities/store";
import { StoreItem } from "../../../../layers/core/interfaces/store";

/*
 * POST /store/currencies/main (store ADMINs, T.5)
 * Body: { storeId, currencyCode, mode: "KEEP_NUMBERS" | "CONVERT" }
 *   → 200 { currencies, deliveryFees, itemsUpdated }
 *
 * Makes `currencyCode` the store's main currency (rules in layers/core/fx/main-currency.ts).
 * Items first, each written only if unchanged since read (re-read and retried), then the
 * settings. When an item can't be written the settings stay as they were: 409 ITEMS_CHANGED
 * (try again; items already moved are skipped). 409 SETTINGS_CHANGED when the currencies changed
 * meanwhile. CONVERT needs today's rates: 503 FX_UNAVAILABLE without them. 10 per store an hour.
 */
export const mainCurrencyLimits = { perStore: createRateLimiter({ windowMs: 60 * 60_000, max: 10 }) };

export default function registerRoutes(router: Router): void {
  router.post("/main", (req: Request, res: Response): void => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      (r) => isUlid(r.body?.storeId) && typeof r.body.currencyCode === "string" && typeof r.body.mode === "string",
      (r) => isCurrencyCode(r.body.currencyCode) && (MAIN_CURRENCY_MODES as readonly string[]).includes(r.body.mode),
      executeRouteCore,
      true,
      storeMember((r) => r.body.storeId, "ADMIN")
    );
  });
}

const ATTEMPTS = 4;
const PARALLEL = 8;

async function executeRouteCore(req: Request, res: Response): Promise<void> {
  const storeId: string = req.body.storeId;
  const to: string = req.body.currencyCode;
  const mode = req.body.mode as MainCurrencyMode;
  try {
    const limited = mainCurrencyLimits.perStore.take(storeId);
    if (!limited.ok) {
      res.setHeader("Retry-After", String(limited.retryAfterSeconds));
      res.status(429).send({ message: "Too many changes. Please try again later.", code: "RATE_LIMITED" });
      return;
    }
    const rates = currentFxRates();
    if (mode === "CONVERT" && !rates) {
      res.status(503).send({ message: "Exchange rates aren't available right now. Please try again later.", code: "FX_UNAVAILABLE" });
      return;
    }
    const data = await getStoreInventoryData(storeId);
    const from = mainCurrency(data.settings.currencies);
    const next = moveSettings(data.settings, to, mode, rates);
    if (from === null || from === to) {
      res.send({ currencies: data.settings.currencies, deliveryFees: data.settings.general?.deliveryFees ?? {}, itemsUpdated: 0 });
      return;
    }
    const rounding = roundingFor(next.currencies, to);
    const move = (i: StoreItem) => moveItemPrices(i, from, to, mode, rates, rounding);

    let updated = 0;
    let failed = 0;
    const one = async (item: StoreItem) => {
      let before: StoreItem | null = item;
      for (let attempt = 0; attempt < ATTEMPTS && before; attempt++) {
        const after = move(before);
        if (after === before) return;
        if (await updateItemParamsIfUnchanged(storeId, before, after)) {
          updated++;
          return;
        }
        before = await getStoreItem(storeId, item.storeItemId);
      }
      if (before) {
        failed++;
        log.error({ storeId, itemId: item.storeItemId }, "[currencies] item prices not moved");
      }
    };
    for (let i = 0; i < data.items.length; i += PARALLEL) {
      await Promise.all(data.items.slice(i, i + PARALLEL).map(one));
    }
    if (failed > 0) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({
        message: "Some items changed while this ran. Please try again.",
        code: "ITEMS_CHANGED",
        itemsUpdated: updated,
        itemsFailed: failed,
      });
      return;
    }
    const fees = next.general?.deliveryFees;
    const feesChanged = fees !== data.settings.general?.deliveryFees;
    if (!(await updateStoreCurrenciesIfUnchanged(storeId, data.settings.currencies, next.currencies, feesChanged ? fees : undefined))) {
      res.status(appConstants.HTTP_STATUS_CODE_CONFLICT).send({
        message: "The store's currencies changed meanwhile. Please reload and try again.",
        code: "SETTINGS_CHANGED",
      });
      return;
    }
    log.info({ storeId, from, to, mode, items: updated }, "[currencies] main currency changed");
    res.send({ currencies: next.currencies, deliveryFees: fees ?? {}, itemsUpdated: updated });
  } catch (e) {
    log.error({ err: e }, "In store/currencies/main");
    res
      .status(appConstants.HTTP_STATUS_CODE_INTERNAL_SERVER_ERROR)
      .send({ message: appConstants.HTTP_ERROR_MSG_INTERNAL_SERVER_ERROR });
  }
}
