import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { Writable } from "stream";
import {
  buildLogger,
  currentRequestId,
  errSerializer,
  maskEmails,
  requestLoggerWith,
  truncateIp,
} from "../layers/core/logger";

/* A logger whose lines land in an array (sync stream, so lines are there right after the call). */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      String(chunk).split("\n").filter(Boolean).forEach((l) => lines.push(JSON.parse(l)));
      cb();
    },
  });
  return { lines, logger: buildLogger(stream, "debug") };
}

describe("logger (9.1)", () => {
  it("redacts sensitive keys at any of the first three levels", () => {
    const { lines, logger } = capture();
    logger.info(
      { email: "a@b.com", authorization: "Bearer x", order: { customer: { name: "Jo", phone: "555" } }, storeId: "S1" },
      "x"
    );
    const l = lines[0] as any;
    expect(l.email).toBe("[redacted]");
    expect(l.authorization).toBe("[redacted]");
    expect(l.order.customer.name).toBe("[redacted]");
    expect(l.order.customer.phone).toBe("[redacted]");
    expect(l.storeId).toBe("S1");
  });

  it("logs errors without the payloads AWS and Stripe attach", () => {
    const e = Object.assign(new Error("Conditional check failed for jo@shop.ca"), {
      name: "ConditionalCheckFailedException",
      $metadata: { httpStatusCode: 400, requestId: "AWS1" },
      Item: { customerEmail: { S: "jo@shop.ca" } },
      raw: { billing_details: { address: "1 Main St" } },
    });
    const out = errSerializer(e);
    expect(out).toMatchObject({ type: "ConditionalCheckFailedException", httpStatusCode: 400, awsRequestId: "AWS1" });
    expect(out.message).toBe("Conditional check failed for [email]");
    expect(JSON.stringify(out)).not.toContain("jo@shop.ca");
    expect(JSON.stringify(out)).not.toContain("Main St");
    expect(out).not.toHaveProperty("Item");
  });

  it("keeps Stripe's type, code and request id; follows a cause a few levels", () => {
    const inner = new Error("inner");
    const e = Object.assign(new Error("outer", { cause: inner }), { type: "StripeCardError", code: "card_declined", requestId: "req_1" });
    expect(errSerializer(e)).toMatchObject({ stripeType: "StripeCardError", code: "card_declined", requestId: "req_1", cause: { message: "inner" } });
    expect(errSerializer("plain")).toEqual({ message: "plain", kind: "string" });
  });

  it("masks emails, also URL-encoded", () => {
    expect(maskEmails("/admin/cancel-store-invite/01J/jo%40shop.ca")).toBe("/admin/cancel-store-invite/01J/[email]");
    expect(maskEmails("to Jo.Smith+x@mail.example.com now")).toBe("to [email] now");
    expect(maskEmails("/store/orders/list/01J")).toBe("/store/orders/list/01J");
  });

  it("truncates IPs", () => {
    expect(truncateIp("203.0.113.77")).toBe("203.0.113.0");
    expect(truncateIp("::ffff:10.1.2.3")).toBe("10.1.2.0");
    expect(truncateIp("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd::");
    expect(truncateIp(undefined)).toBe("unknown");
  });

  it("gives each request an id, logs one line, and the id reaches logs made inside it", async () => {
    const { lines, logger } = capture();
    const app = express();
    app.use(requestLoggerWith(logger));
    app.get("/x/:email", (_req, res) => {
      logger.child({ area: "t" }).info({ reqIdSeen: currentRequestId() }, "inside");
      res.status(404).send({});
    });
    const res = await request(app).get("/x/jo@shop.ca?token=secret");
    const id = res.headers["x-request-id"];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const inside = lines.find((l) => l.msg === "inside") as any;
    expect(inside.reqIdSeen).toBe(id);
    const line = lines.find((l) => l.msg === "request") as any;
    expect(line).toMatchObject({ reqId: id, method: "GET", path: "/x/[email]", status: 404, level: 40 });
    expect(JSON.stringify(lines)).not.toContain("secret");
    expect(JSON.stringify(lines)).not.toContain("jo@shop.ca");
  });

  it("keeps a well-formed incoming X-Request-Id, replaces a bad one", async () => {
    const { logger } = capture();
    const app = express();
    app.use(requestLoggerWith(logger));
    app.get("/", (_req, res) => res.send("ok"));
    expect((await request(app).get("/").set("X-Request-Id", "abc12345def")).headers["x-request-id"]).toBe("abc12345def");
    expect((await request(app).get("/").set("X-Request-Id", "<script>x</script>")).headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
