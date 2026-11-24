/*
 * Automatic currency conversion (Stage T.4, owner 2026-11-23).
 *
 * A store has one main currency (`currencyIsDefault`). An item stores its price in the main
 * currency plus any prices the merchant set by hand; every other offered currency is converted
 * from the main price at the day's rate and rounded the way that currency asks
 * (`currencyRounding`). A price set by hand always wins. Same for variant rows and delivery fees.
 *
 * Pure functions here; the rates come from `currentFxRates()` (kept in memory, loaded from the
 * `APP_FX / LATEST` row and refreshed daily by `layers/core/fx/refresh.ts`). With no rates (a
 * fresh table, the source down since before the server started) nothing is converted and stores
 * sell only in the currencies they priced by hand, as before Stage T.
 */
import { CURRENCY_CODES } from "../../../constants/input-limits";

export const CURRENCY_ROUNDINGS = ["EXACT", "WHOLE", "NINETY_NINE"] as const;
export type CurrencyRounding = (typeof CURRENCY_ROUNDINGS)[number];
/** What an added currency's automatic prices use unless the merchant picks another. */
export const DEFAULT_ROUNDING: CurrencyRounding = "NINETY_NINE";

export interface FxRates {
  /** The day the rates are for (YYYY-MM-DD, the source's). */
  date: string;
  /** Units of each currency per 1 USD (USD = 1). */
  rates: Record<string, number>;
}

/** The rate used on a quote or order in another currency than the store's main one. */
export interface AppliedFx {
  from: string;
  to: string;
  /** Units of `to` per unit of `from`. */
  rate: number;
  date: string;
}

let current: FxRates | null = null;

/** The rates in use now (null until loaded). */
export function currentFxRates(): FxRates | null {
  return current;
}

/** Sets the rates in use (the refresher; tests). Invalid rates are ignored. */
export function setFxRates(rates: FxRates | null): void {
  if (rates === null || isFxRates(rates)) current = rates;
}

export function isFxRates(v: unknown): v is FxRates {
  if (typeof v !== "object" || v === null) return false;
  const r = v as FxRates;
  return (
    typeof r.date === "string" &&
    typeof r.rates === "object" &&
    r.rates !== null &&
    CURRENCY_CODES.every((c) => typeof r.rates[c] === "number" && Number.isFinite(r.rates[c]) && r.rates[c] > 0)
  );
}

export function isCurrencyRounding(v: unknown): v is CurrencyRounding {
  return typeof v === "string" && (CURRENCY_ROUNDINGS as readonly string[]).includes(v);
}

/** Units of `to` per unit of `from`, or null when either is unknown. */
export function fxRate(rates: FxRates | null, from: string, to: string): number | null {
  if (from === to) return 1;
  const a = rates?.rates[from];
  const b = rates?.rates[to];
  return a && b ? b / a : null;
}

/**
 * `minor` (cents of `from`) in `to`, rounded: EXACT to the cent (half up), WHOLE to the nearest
 * whole unit, NINETY_NINE to the nearest price ending in .99. A price above 0 never becomes 0
 * (it stays at least 1 unit, or 0.99). 0 (free) stays 0. Null without a rate.
 */
export function convertMinor(
  minor: number,
  from: string,
  to: string,
  rates: FxRates | null,
  rounding: CurrencyRounding = DEFAULT_ROUNDING
): number | null {
  if (from === to) return minor;
  const rate = fxRate(rates, from, to);
  if (rate === null || !Number.isFinite(minor)) return null;
  if (minor <= 0) return 0;
  const exact = minor * rate;
  switch (rounding) {
    case "WHOLE":
      return Math.max(100, Math.round(exact / 100) * 100);
    case "NINETY_NINE":
      return Math.max(99, Math.round(exact / 100) * 100 - 1);
    default:
      return Math.max(1, Math.round(exact));
  }
}

interface CurrencyLike {
  currencyCode: string;
  currencyIsDefault: boolean;
  currencyRounding?: string;
}

/** The store's main currency code (the default one; the first if none is marked). */
export function mainCurrency(currencies: CurrencyLike[]): string | null {
  return (currencies.find((c) => c.currencyIsDefault) ?? currencies[0])?.currencyCode ?? null;
}

function roundingOf(c: CurrencyLike): CurrencyRounding {
  return isCurrencyRounding(c.currencyRounding) ? c.currencyRounding : DEFAULT_ROUNDING;
}

/**
 * Prices for every offered currency: the ones set by hand, then the rest converted from the
 * main-currency price (or, when an item has none, from its first set price in CURRENCY_CODES
 * order: e.g. the main currency was switched without converting). Set prices in currencies the
 * store doesn't offer are kept (the caller cuts them). `auto` lists the converted codes.
 */
export function effectivePrices(
  prices: Partial<Record<string, number>> | undefined,
  currencies: CurrencyLike[],
  rates: FxRates | null
): { prices: Record<string, number>; auto: string[] } {
  const out: Record<string, number> = {};
  for (const [code, minor] of Object.entries(prices ?? {})) {
    if (typeof minor === "number") out[code] = minor;
  }
  const auto: string[] = [];
  const main = mainCurrency(currencies);
  const source =
    main !== null && typeof out[main] === "number"
      ? main
      : CURRENCY_CODES.find((c) => typeof out[c] === "number") ?? null;
  if (source === null || !rates) return { prices: out, auto };
  for (const c of currencies) {
    if (typeof out[c.currencyCode] === "number") continue;
    const converted = convertMinor(out[source], source, c.currencyCode, rates, roundingOf(c));
    if (converted !== null) {
      out[c.currencyCode] = converted;
      auto.push(c.currencyCode);
    }
  }
  return { prices: out, auto };
}

/** The rate a quote in `currency` used, when it isn't the main one (recorded on orders). */
export function appliedFx(currencies: CurrencyLike[], currency: string, rates: FxRates | null): AppliedFx | null {
  const main = mainCurrency(currencies);
  if (!rates || main === null || main === currency) return null;
  const rate = fxRate(rates, main, currency);
  return rate === null ? null : { from: main, to: currency, rate: Math.round(rate * 1e6) / 1e6, date: rates.date };
}
