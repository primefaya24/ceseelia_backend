import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import Stripe from "stripe";
import { mockClient } from "aws-sdk-client-mock";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  findUserIdByCognitoId: vi.fn(async () => "USER1"),
}));
const role = { current: "ADMIN" as "ADMIN" | "MERCHANT" };
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getMembership: vi.fn(async (storeId: string, userId: string) => ({
    storeId,
    userId,
    role: role.current,
    createdAt: 1,
  })),
}));
const stripe = {
  accounts: { create: vi.fn(), retrieve: vi.fn() },
  accountLinks: { create: vi.fn() },
};
vi.mock("../layers/payments/stripe", async (orig) => ({
  ...(await orig<typeof import("../layers/payments/stripe")>()),
  getStripe: vi.fn(async () => stripe),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import {
  getStripe,
  parseStripeSecrets,
  PaymentsNotConfiguredError,
} from "../layers/payments/stripe";
import { createApp } from "../app";
import { initStoreSettings } from "../layers/core/interfaces/store";

const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = "01JBZ0000000000000000000AA";
const ACCT = "acct_123";
const asMember = () =>
  vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "m", "cognito:groups": [] });
const createLink = (body: object) =>
  request(app)
    .post("/api/v1/store/payments/create-connect-account-link")
    .set("Host", "localhost")
    .set("Authorization", "Bearer t")
    .send({ storeId: STORE, ...body });
const status = () =>
  request(app)
    .get(`/api/v1/store/payments/status/${STORE}`)
    .set("Host", "localhost")
    .set("Authorization", "Bearer t");
const withPayments = (payments?: object) =>
  ddb
    .on(GetCommand)
    .resolves({ Item: { pk: `STORE#${STORE}`, ...(payments ? { payments } : {}) } });
const conditionFailed = () => new ConditionalCheckFailedException({ message: "no", $metadata: {} });

beforeEach(() => {
  ddb.reset();
  vi.clearAllMocks();
  role.current = "ADMIN";
  asMember();
  vi.spyOn(console, "error").mockImplementation(() => {});
  stripe.accounts.create.mockResolvedValue({ id: ACCT });
  stripe.accountLinks.create.mockResolvedValue({
    url: "https://connect.stripe.com/setup/s/x",
    expires_at: 1700000300,
  });
});

describe("POST /store/payments/create-connect-account-link", () => {
  it("creates a Standard account in the chosen country, saves it, and returns a link", async () => {
    withPayments();
    ddb.on(UpdateCommand).resolves({});
    const res = await createLink({ country: "CA" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "https://connect.stripe.com/setup/s/x",
      expiresAt: 1700000300,
    });
    expect(stripe.accounts.create).toHaveBeenCalledWith(
      { type: "standard", country: "CA", metadata: { storeId: STORE } },
      { idempotencyKey: `store-${STORE}-account-0-CA` }
    );
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBe(
      "attribute_exists(pk) AND attribute_not_exists(#payments.#acct)"
    );
    expect(input.ExpressionAttributeValues?.[":payments"]).toMatchObject({
      stripeAccountId: ACCT,
      chargesEnabled: false,
    });
    expect(stripe.accountLinks.create).toHaveBeenCalledWith({
      account: ACCT,
      type: "account_onboarding",
      refresh_url: `http://localhost:4200/store/storefront/${STORE}?payments=refresh`,
      return_url: `http://localhost:4200/store/storefront/${STORE}?payments=return`,
    });
  });

  it("reuses the saved account (no country needed)", async () => {
    withPayments({ stripeAccountId: "acct_saved" });
    const res = await createLink({});
    expect(res.status).toBe(200);
    expect(stripe.accounts.create).not.toHaveBeenCalled();
    expect(stripe.accountLinks.create.mock.calls[0][0].account).toBe("acct_saved");
  });

  it("uses the account saved first when two requests race", async () => {
    ddb
      .on(GetCommand)
      .resolvesOnce({ Item: { pk: "p" } })
      .resolves({ Item: { pk: "p", payments: { stripeAccountId: "acct_first" } } });
    ddb.on(UpdateCommand).rejects(conditionFailed());
    const res = await createLink({ country: "US" });
    expect(res.status).toBe(200);
    expect(stripe.accountLinks.create.mock.calls[0][0].account).toBe("acct_first");
  });

  it("gives a store that disconnected its old account a new idempotency key", async () => {
    withPayments({ disconnectedAt: 42 });
    ddb.on(UpdateCommand).resolves({});
    await createLink({ country: "AU" });
    expect(stripe.accounts.create.mock.calls[0][1]).toEqual({
      idempotencyKey: `store-${STORE}-account-42-AU`,
    });
  });

  it("400 COUNTRY_REQUIRED without an account or country; 400 for other countries", async () => {
    withPayments();
    const res = await createLink({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("COUNTRY_REQUIRED");
    expect((await createLink({ country: "GB" })).status).toBe(400);
    expect((await createLink({ country: 1 })).status).toBe(400);
    expect(stripe.accounts.create).not.toHaveBeenCalled();
  });

  it("is for store admins only", async () => {
    role.current = "MERCHANT";
    expect((await createLink({ country: "CA" })).status).toBe(403);
    expect(stripe.accounts.create).not.toHaveBeenCalled();
  });

  it("404 for a missing store", async () => {
    ddb.on(GetCommand).resolves({});
    const res = await createLink({ country: "CA" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("STORE_NOT_FOUND");
  });

  it("503 when Stripe isn't configured; 502 (without Stripe's message) when Stripe fails", async () => {
    withPayments();
    vi.mocked(getStripe).mockRejectedValueOnce(new PaymentsNotConfiguredError("x"));
    let res = await createLink({ country: "CA" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("PAYMENTS_NOT_CONFIGURED");

    stripe.accounts.create.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        message: "secret detail",
        type: "invalid_request_error",
      })
    );
    res = await createLink({ country: "CA" });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      message: "Stripe couldn't complete the request. Please try again.",
      code: "STRIPE_ERROR",
    });
  });
});

describe("GET /store/payments/status/:storeId", () => {
  const account = (patch: object = {}) => ({
    id: ACCT,
    charges_enabled: true,
    payouts_enabled: false,
    details_submitted: true,
    country: "CA",
    default_currency: "cad",
    requirements: {
      currently_due: ["external_account"],
      past_due: [],
      current_deadline: null,
      disabled_reason: null,
    },
    ...patch,
  });

  it("says not connected without an account", async () => {
    withPayments();
    expect((await status()).body).toEqual({ canManage: true, connected: false });
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
  });

  it("is open to any store member; only store admins may manage", async () => {
    role.current = "MERCHANT";
    withPayments();
    const res = await status();
    expect(res.status).toBe(200);
    expect(res.body.canManage).toBe(false);
  });

  it("platform admins may manage any store", async () => {
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({
      sub: "a",
      "cognito:groups": ["Admins"],
    });
    withPayments();
    expect((await status()).body.canManage).toBe(true);
  });

  it("reads Stripe and refreshes changed flags for that account only", async () => {
    withPayments({
      stripeAccountId: ACCT,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    });
    ddb.on(UpdateCommand).resolves({});
    stripe.accounts.retrieve.mockResolvedValue(account());
    const res = await status();
    expect(res.body).toEqual({
      canManage: true,
      connected: true,
      chargesEnabled: true,
      payoutsEnabled: false,
      detailsSubmitted: true,
      requirementsDue: 1,
      pastDue: 0,
      pendingVerification: 0,
      deadline: null,
      disabledReason: null,
      country: "CA",
      defaultCurrency: "CAD",
    });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBe("#payments.#acct = :acct");
    expect(input.ExpressionAttributeValues).toMatchObject({
      ":acct": ACCT,
      ":charges": true,
      ":details": true,
    });
  });

  it("counts past-due details once and reports Stripe's deadline", async () => {
    withPayments({
      stripeAccountId: ACCT,
      chargesEnabled: true,
      payoutsEnabled: false,
      detailsSubmitted: true,
    });
    stripe.accounts.retrieve.mockResolvedValue(
      account({
        requirements: {
          currently_due: ["individual.verification.proof_of_liveness", "external_account"],
          past_due: ["individual.verification.proof_of_liveness"],
          current_deadline: null,
          disabled_reason: "requirements.past_due",
        },
        future_requirements: { current_deadline: 1_800_000_000 },
      })
    );
    const res = await status();
    expect(res.body).toMatchObject({
      requirementsDue: 2,
      pastDue: 1,
      deadline: 1_800_000_000_000,
      disabledReason: "requirements.past_due",
    });
  });

  it("reports details Stripe is still checking (sandbox case)", async () => {
    withPayments({
      stripeAccountId: ACCT,
      chargesEnabled: true,
      payoutsEnabled: false,
      detailsSubmitted: true,
    });
    stripe.accounts.retrieve.mockResolvedValue(
      account({
        payouts_enabled: false,
        requirements: {
          currently_due: [],
          past_due: [],
          pending_verification: [
            "individual.verification.document",
            "individual.verification.proof_of_liveness",
          ],
          current_deadline: null,
          disabled_reason: "requirements.pending_verification",
        },
      })
    );
    expect((await status()).body).toMatchObject({
      requirementsDue: 0,
      pastDue: 0,
      pendingVerification: 2,
    });
  });

  it("doesn't write when nothing changed", async () => {
    withPayments({
      stripeAccountId: ACCT,
      chargesEnabled: true,
      payoutsEnabled: false,
      detailsSubmitted: true,
    });
    stripe.accounts.retrieve.mockResolvedValue(account());
    await status();
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("forgets an account the merchant disconnected", async () => {
    withPayments({ stripeAccountId: ACCT, chargesEnabled: true });
    ddb.on(UpdateCommand).resolves({});
    stripe.accounts.retrieve.mockRejectedValue(
      new Stripe.errors.StripePermissionError({
        message: "no access",
        type: "invalid_request_error",
      })
    );
    expect((await status()).body).toEqual({
      canManage: true,
      connected: false,
      disconnected: true,
    });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues?.[":payments"]).toEqual({
      disconnectedAt: expect.any(Number),
    });
  });

  it("502 for other Stripe errors, keeping the account", async () => {
    withPayments({ stripeAccountId: ACCT });
    stripe.accounts.retrieve.mockRejectedValue(
      new Stripe.errors.StripeConnectionError({ message: "down", type: "api_error" })
    );
    expect((await status()).status).toBe(502);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe("payments stay private", () => {
  const settingsRow = (chargesEnabled: boolean) => ({
    pk: "p",
    sk: "s",
    ...initStoreSettings(),
    payments: { stripeAccountId: ACCT, chargesEnabled },
  });

  it("members' get-data leaves the payments attribute out", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(GetCommand).resolves({ Item: settingsRow(true) });
    role.current = "MERCHANT";
    const res = await request(app)
      .get(`/api/v1/store/inventory/get-data/${STORE}`)
      .set("Host", "localhost")
      .set("Authorization", "Bearer t");
    expect(res.status).toBe(200);
    expect(res.body.settings).not.toHaveProperty("payments");
  });

  it.each([true, false])(
    "the public storefront gets only paymentsEnabled (%s)",
    async (enabled) => {
      ddb.on(QueryCommand).resolves({ Items: [] });
      ddb.on(GetCommand).resolves({ Item: settingsRow(enabled) });
      const res = await request(app)
        .get(`/api/v1/store/inventory/get-data-public/${STORE}`)
        .set("Host", "localhost");
      expect(res.status).toBe(200);
      expect(res.body.settings).not.toHaveProperty("payments");
      expect(res.body.settings.paymentsEnabled).toBe(enabled);
      expect(JSON.stringify(res.body)).not.toContain(ACCT);
    }
  );
});

describe("parseStripeSecrets", () => {
  const ok = "sk_test_" + "a".repeat(20);
  it("accepts secret and restricted keys", () => {
    expect(
      parseStripeSecrets(JSON.stringify({ secretKey: ok, webhookSecret: "whsec_1" }), true)
    ).toEqual({
      secretKey: ok,
      webhookSecret: "whsec_1",
    });
    expect(
      parseStripeSecrets(JSON.stringify({ secretKey: "rk_live_abc" }), false).webhookSecret
    ).toBe("");
  });

  it.each([
    ["not json", "{"],
    ["the placeholder", JSON.stringify({ secretKey: "REPLACE_IN_CONSOLE" })],
    ["a publishable key", JSON.stringify({ secretKey: "pk_test_abc" })],
    ["nothing", undefined],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseStripeSecrets(raw, true)).toThrow(PaymentsNotConfiguredError);
  });

  it("refuses a live key in dev, and never puts the key in the message", () => {
    const live = "sk_live_" + "b".repeat(20);
    expect(() => parseStripeSecrets(JSON.stringify({ secretKey: live }), true)).toThrow(
      /test-mode key/
    );
    try {
      parseStripeSecrets(JSON.stringify({ secretKey: live }), true);
    } catch (e) {
      expect((e as Error).message).not.toContain(live);
    }
  });
});
