import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

// getClientIp returns a fixed test IP in dev; check the production path.
vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  IN_DEV: false,
}));

import { getClientIp } from "../layers/core/utils";
import { TRUST_PROXY_HOPS } from "../config";

describe("trusted client IP (S.13)", () => {
  it("trusts exactly one proxy hop by default (nginx)", () => {
    expect(TRUST_PROXY_HOPS).toBe(1);
  });

  // The app sits behind nginx, which appends the real peer address to X-Forwarded-For.
  // A client can put anything before it, but only the last (nginx-added) entry is trusted.
  function appEchoingIp() {
    const app = express();
    app.set("trust proxy", TRUST_PROXY_HOPS);
    app.get("/ip", (req, res) => void res.send({ ip: getClientIp(req) ?? null }));
    return app;
  }

  it("uses the address nginx added, not one the client forged", async () => {
    const res = await request(appEchoingIp()).get("/ip").set("X-Forwarded-For", "6.6.6.6, 203.0.113.7");
    expect(res.body.ip).toBe("203.0.113.7");
  });

  it("ignores CF-Connecting-IP (no Cloudflare in front, so anyone could set it)", async () => {
    const res = await request(appEchoingIp())
      .get("/ip")
      .set("CF-Connecting-IP", "6.6.6.6")
      .set("X-Forwarded-For", "203.0.113.7");
    expect(res.body.ip).toBe("203.0.113.7");
  });

  it("falls back to the socket address when no proxy header is present", async () => {
    const res = await request(appEchoingIp()).get("/ip");
    expect(res.body.ip).toMatch(/^(127\.0\.0\.1|::1)$/);
  });

  it("strips the IPv4-mapped prefix", () => {
    expect(getClientIp({ ip: "::ffff:203.0.113.7" } as any)).toBe("203.0.113.7");
    expect(getClientIp({ ip: "2001:db8::1" } as any)).toBe("2001:db8::1");
    expect(getClientIp({ ip: undefined } as any)).toBeUndefined();
  });
});
