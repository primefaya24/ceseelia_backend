import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { API_RATE_LIMIT, PUBLIC_READ_RATE_LIMIT } from "../layers/core/http/api-limits";

/* Unauthenticated calls that fail fast (401 / 400) without touching AWS. */
const AUTH_ROUTE = "/api/v1/user/get-my-profile";
const PUBLIC_ROUTE = "/api/v1/store/public/resolve-slug/NOT_A_SLUG!";

async function hit(app: ReturnType<typeof createApp>, path: string, n: number) {
  let last;
  for (let i = 0; i < n; i++) last = await request(app).get(path).set("Host", "localhost");
  return last!;
}

describe("API rate limits (9.2)", () => {
  it("allows the per-IP budget, then answers 429 RATE_LIMITED with Retry-After", async () => {
    const app = createApp();
    const ok = await hit(app, AUTH_ROUTE, API_RATE_LIMIT.max);
    expect(ok.status).toBe(401);
    expect(ok.headers["ratelimit-policy"]).toBeDefined();
    const res = await request(app).get(AUTH_ROUTE).set("Host", "localhost");
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("limits the public storefront reads sooner", async () => {
    const app = createApp();
    expect((await hit(app, PUBLIC_ROUTE, PUBLIC_READ_RATE_LIMIT.max)).status).toBe(400);
    const res = await request(app).get(PUBLIC_ROUTE).set("Host", "localhost");
    expect(res.status).toBe(429);
    // A signed-in route is still within the general budget
    expect((await request(app).get(AUTH_ROUTE).set("Host", "localhost")).status).toBe(401);
  });

  it("never limits Stripe's webhooks or /healthz", async () => {
    const app = createApp();
    await hit(app, AUTH_ROUTE, API_RATE_LIMIT.max + 1);
    const wh = await request(app)
      .post("/api/v1/payments/stripe-connect-webhook")
      .set("Host", "localhost")
      .set("Content-Type", "application/json")
      .send("{}");
    expect(wh.status).not.toBe(429);
    expect((await request(app).get("/healthz")).status).toBe(200);
  });

  it("gives each response an X-Request-Id", async () => {
    const res = await request(createApp()).get(AUTH_ROUTE).set("Host", "localhost");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("JSON body limits (9.2)", () => {
  const big = (kb: number) => JSON.stringify({ storeId: "x", pad: "a".repeat(kb * 1024) });

  it("refuses bodies over 100 KB with 413 BODY_TOO_LARGE", async () => {
    const res = await request(createApp())
      .put("/api/v1/user/update-profile")
      .set("Host", "localhost")
      .set("Content-Type", "application/json")
      .send(big(120));
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("BODY_TOO_LARGE");
  });

  it("lets item and settings saves send up to 256 KB", async () => {
    const app = createApp();
    const item = await request(app)
      .post("/api/v1/store/inventory/create-item")
      .set("Host", "localhost")
      .set("Content-Type", "application/json")
      .send(big(200));
    expect(item.status).toBe(401); // parsed, then refused for no token
    const tooBig = await request(app)
      .put("/api/v1/store/update-settings")
      .set("Host", "localhost")
      .set("Content-Type", "application/json")
      .send(big(300));
    expect(tooBig.status).toBe(413);
  });

  it("answers malformed JSON with 400 INVALID_JSON", async () => {
    const res = await request(createApp())
      .put("/api/v1/user/update-profile")
      .set("Host", "localhost")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_JSON");
  });
});
