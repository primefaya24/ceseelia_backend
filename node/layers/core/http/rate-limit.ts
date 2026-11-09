/*
 * A small fixed-window rate limiter kept in memory (progress.md 3.4). Fine for the single API
 * server; with more than one instance, move the counts to a shared store (9.2). Keys are things
 * like an IP or `store:<id>`.
 */
export interface RateLimiter {
  /** Counts one hit for `key`; refused (with seconds to wait) once `max` is used up. */
  take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number };
  /** Forget every count (tests). */
  reset(): void;
}

export function createRateLimiter(opts: { windowMs: number; max: number; now?: () => number }): RateLimiter {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { count: number; resetAt: number }>();
  const sweep = (t: number) => {
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  };
  return {
    take(key) {
      const t = now();
      if (hits.size > 10_000) sweep(t);
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        hits.set(key, { count: 1, resetAt: t + opts.windowMs });
        return { ok: true };
      }
      if (entry.count >= opts.max) {
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - t) / 1000)) };
      }
      entry.count++;
      return { ok: true };
    },
    reset() {
      hits.clear();
    },
  };
}
