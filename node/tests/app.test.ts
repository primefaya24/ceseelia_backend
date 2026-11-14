import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildCorsOptions, createApp } from "../app";
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
