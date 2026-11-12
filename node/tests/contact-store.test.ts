import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { ulid } from "ulid";

import { createApp } from "../app";
import { contactLimits } from "../api/v1/customer/contact-store";
import { createRateLimiter } from "../layers/core/http/rate-limit";
import { initStoreSettings } from "../layers/core/interfaces/store";

const ddb = mockClient(DynamoDBDocumentClient);
const ses = mockClient(SESClient);
const app = createApp();
const STORE = ulid();

function store(email = "owner@hoop.test", extra: object = {}) {
  const s = initStoreSettings();
  ddb.on(GetCommand).resolves({
    Item: {
      pk: `STORE#${STORE}`,
      sk: "SETTINGS",
      ...s,
      storeInfo: { ...s.storeInfo, storeName: "Northern <Hoop>", emailaddress: email },
      ...extra,
    },
  });
}
const body = (patch: object = {}) => ({
  storeId: STORE,
  name: "Sam",
  email: "sam@example.test",
  message: "Hi!\nDo you ship to Canada? <b>bold</b>",
  website: "",
  ...patch,
});
const post = (b: object) => request(app).post("/api/v1/customer/contact-store").set("Host", "localhost").send(b);
const sentEmail = () => ses.commandCalls(SendEmailCommand)[0]?.args[0].input;

beforeEach(() => {
  ddb.reset();
  ses.reset();
  ses.on(SendEmailCommand).resolves({ MessageId: "m1" });
  contactLimits.perIp.reset();
  contactLimits.perStore.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /customer/contact-store (3.4)", () => {
  it("emails the store from our address with the customer as Reply-To, escaping their text", async () => {
    store();
    const res = await post(body());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    const input = sentEmail()!;
    expect(input.Destination!.ToAddresses).toEqual(["owner@hoop.test"]);
    expect(input.Source).toBe("Ceseelia <support@ceseelia.com>");
    expect(input.ReplyToAddresses).toEqual(["sam@example.test"]);
    expect(input.Message!.Subject!.Data).toBe("Message from Sam via your Ceseelia store");
    const html = input.Message!.Body!.Html!.Data!;
    expect(html).toContain("Northern &lt;Hoop&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("Hi!<br>Do you ship");
    expect(html).not.toContain("<b>bold</b>");
  });

  it("a filled honeypot gets the same 200, but nothing is sent or read", async () => {
    store();
    const res = await post(body({ website: "http://spam.test" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect(ddb.calls()).toHaveLength(0);
  });

  it.each([
    ["a bad storeId", { storeId: "x" }],
    ["no name", { name: "  " }],
    ["a long name", { name: "n".repeat(51) }],
    ["a newline in the name (header injection)", { name: "Sam\r\nBcc: x@y.test" }],
    ["a bad email", { email: "nope" }],
    ["a newline in the email", { email: "a@b.test\nBcc: x@y.test" }],
    ["no message", { message: "" }],
    ["a message over 2000 characters", { message: "m".repeat(2001) }],
    ["a non-string field", { message: 5 }],
  ])("refuses %s with a 400, without sending", async (_n, patch) => {
    store();
    expect((await post(body(patch))).status).toBe(400);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("allows newlines and tabs in the message", async () => {
    store();
    expect((await post(body({ message: "line 1\r\n\tline 2" }))).status).toBe(200);
  });

  it("409 CONTACT_UNAVAILABLE when the store has no contact email", async () => {
    store("");
    const res = await post(body());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONTACT_UNAVAILABLE");
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("unknown and suspended stores get the storefront's 404s", async () => {
    ddb.on(GetCommand).resolves({});
    expect((await post(body())).body.code).toBe("STORE_NOT_FOUND");
    store("owner@hoop.test", { admin: { isStoreLive: false } });
    expect((await post(body())).body.code).toBe("STORE_UNAVAILABLE");
  });

  it("an SES failure is a 500 SEND_FAILED", async () => {
    store();
    ses.on(SendEmailCommand).rejects(new Error("throttled"));
    const res = await post(body());
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("SEND_FAILED");
  });

  it("5 messages per IP per 10 minutes, then 429 with Retry-After", async () => {
    store();
    for (let i = 0; i < 5; i++) expect((await post(body())).status).toBe(200);
    const res = await post(body());
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(5);
  });

  it("bots filling the honeypot use up the same IP limit", async () => {
    store();
    for (let i = 0; i < 5; i++) await post(body({ website: "x" }));
    expect((await post(body())).status).toBe(429);
  });
});

describe("createRateLimiter", () => {
  it("counts per key and resets after the window", () => {
    let t = 0;
    const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(limiter.take("b").ok).toBe(true);
    t = 1000;
    expect(limiter.take("a").ok).toBe(true);
  });

  it("the per-store limit is 30 an hour", () => {
    for (let i = 0; i < 30; i++) expect(contactLimits.perStore.take("store:s").ok).toBe(true);
    expect(contactLimits.perStore.take("store:s").ok).toBe(false);
  });
});
