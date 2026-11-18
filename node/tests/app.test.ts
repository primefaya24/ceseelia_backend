import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { allowPrivateNetwork, buildCorsOptions, createApp, markShuttingDown } from "../app";
import { isAllowedApiHost } from "../middleware";

function originAllowed(options: ReturnType<typeof buildCorsOptions>, origin: string | undefined) {
  return new Promise<boolean>((resolve) => {
    if (options.origin === true) return resolve(true);
    (options.origin as any)(origin, (_err: unknown, allow: boolean) => resolve(allow));
  });
}

describe("buildCorsOptions", () => {
  it("reflects any origin in dev when no list is configured", () => {
    expect(buildCorsOptions([], true).origin).toBe(true);
  });

  it("only allows listed origins otherwise", async () => {
    const opts = buildCorsOptions(["https://app.ceseelia.com"], false);
    expect(await originAllowed(opts, "https://app.ceseelia.com")).toBe(true);
    expect(await originAllowed(opts, "https://evil.example")).toBe(false);
    expect(await originAllowed(opts, undefined)).toBe(true);
  });
});

describe("host routing", () => {
  it("accepts configured API hosts and localhost in dev", () => {
    expect(isAllowedApiHost("api.ceseelia.com")).toBe(true);
    expect(isAllowedApiHost("localhost")).toBe(true);
    expect(isAllowedApiHost("evil.example")).toBe(false);
  });

  it("returns 404 for unknown hosts", async () => {
    const res = await request(createApp()).get("/api/v1/user/get-my-profile").set("Host", "evil.example");
    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated API calls with 401", async () => {
    const res = await request(createApp()).get("/api/v1/user/get-my-profile").set("Host", "localhost");
    expect(res.status).toBe(401);
  });

  it("the Connect webhook answers an unsigned request with 400 or 503, never hangs (5.5)", async () => {
    const res = await request(createApp())
      .post("/api/v1/payments/stripe-connect-webhook")
      .set("Content-Type", "application/json")
      .send("{}");
    expect([400, 503]).toContain(res.status);
  });
});

describe("security headers and /healthz (S.14, 9.3)", () => {
  it("helmet headers are on every response; no x-powered-by", async () => {
    const res = await request(createApp()).get("/healthz");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toContain("max-age=");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("/healthz answers on any host, uncached; 503 once shutting down", async () => {
    const app = createApp();
    const ok = await request(app).get("/healthz").set("Host", "127.0.0.1:3100");
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    expect(ok.headers["cache-control"]).toBe("no-store");
    markShuttingDown();
    const down = await request(app).get("/healthz");
    expect(down.status).toBe(503);
  });
});

describe("allowPrivateNetwork (dev: dev.ceseelia.com → the local backend)", () => {
  const run = (method: string, headers: Record<string, string>) => {
    const set = vi.fn();
    const next = vi.fn();
    allowPrivateNetwork({ method, get: (h: string) => headers[h] } as never, { set } as never, next);
    return { set, next };
  };
  it("says yes to a private-network preflight, and only to that", () => {
    const yes = run("OPTIONS", { "Access-Control-Request-Private-Network": "true" });
    expect(yes.set).toHaveBeenCalledWith("Access-Control-Allow-Private-Network", "true");
    expect(yes.next).toHaveBeenCalled();
    expect(run("OPTIONS", {}).set).not.toHaveBeenCalled();
    expect(run("GET", { "Access-Control-Request-Private-Network": "true" }).set).not.toHaveBeenCalled();
  });
});
