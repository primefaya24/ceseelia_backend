import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  findUserIdByCognitoId: vi.fn(async () => "USER1"),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getMembership: vi.fn(async (storeId: string, userId: string) => ({ storeId, userId, role: "ADMIN", createdAt: 1 })),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";
import { commissionBaseMinor, FeeQuote, platformFeeMinor } from "../layers/core/interfaces/store";

const ddb = mockClient(DynamoDBDocumentClient);
const app = createApp();
const STORE = "01JBZ0000000000000000000AA";
const asAdmin = () => vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "a", "cognito:groups": ["Admins"] });
const asMember = () => vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "m", "cognito:groups": [] });
const put = (body: object) =>
  request(app).put("/api/v1/admin/update-store-admin-settings").set("Host", "localhost").set("Authorization", "Bearer t").send(body);
const getAdmin = () =>
  request(app).get(`/api/v1/admin/get-store-admin-settings/${STORE}`).set("Host", "localhost").set("Authorization", "Bearer t");
const fees = { USD: 250, CAD: 300, AUD: 0 };
const valid = { storeId: STORE, commissionMode: "FIXED", commissionPercentBps: 0, salesCommissions: fees, suspended: true };
const saved = { commissionMode: "FIXED", commissionPercentBps: 0, salesCommissions: fees, suspended: true };
/** What a read returns: the defaults for 5.1b's fields plus these. */
const block = (b: object) => ({ commissionMode: "FIXED", commissionPercentBps: 0, ...b });

beforeEach(() => {
  ddb.reset();
  vi.mocked(verifyCognitoAccessToken).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  asAdmin();
});

describe("PUT /admin/update-store-admin-settings", () => {
  it("saves only commission and store-live on the SETTINGS row", async () => {
    ddb.on(UpdateCommand).resolves({});
    const res = await put({ ...valid, extra: "ignored" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(saved);
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual({ pk: `STORE#${STORE}`, sk: "SETTINGS" });
    expect(input.UpdateExpression).toBe("SET #admin = :admin");
    expect(input.ExpressionAttributeValues).toEqual({ ":admin": saved });
    expect(input.ConditionExpression).toBe("attribute_exists(pk)");
  });

  it("is admin-only, even for the store's own admin member", async () => {
    asMember();
    expect((await put(valid)).status).toBe(403);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it.each([
    [{ ...valid, salesCommissions: { ...fees, USD: -1 } }],
    [{ ...valid, salesCommissions: { ...fees, USD: 100_001 } }],
    [{ ...valid, salesCommissions: { ...fees, USD: 1.5 } }],
    [{ ...valid, salesCommissions: { ...fees, CAD: "200" } }],
    [{ ...valid, salesCommissions: { USD: 100, CAD: 100 } }],
    [{ ...valid, salesCommissions: { ...fees, EUR: 100 } }],
    [{ ...valid, salesCommissions: 125 }],
    [{ ...valid, salesCommission: 1.25, salesCommissions: undefined }],
    [{ ...valid, suspended: "yes" }],
    // P.2: the old field name is refused, not silently read
    [{ storeId: STORE, commissionMode: "FIXED", commissionPercentBps: 0, salesCommissions: fees, isStoreLive: true }],
    [{ storeId: STORE, salesCommissions: fees }],
    // 5.1b: mode and percentage are required and checked
    [{ ...valid, commissionMode: undefined }],
    [{ ...valid, commissionMode: "percent" }],
    [{ ...valid, commissionMode: "TIERED" }],
    [{ ...valid, commissionMode: ["PERCENT"] }],
    [{ ...valid, commissionPercentBps: undefined }],
    [{ ...valid, commissionPercentBps: -1 }],
    [{ ...valid, commissionPercentBps: 3_001 }],
    [{ ...valid, commissionPercentBps: 2.5 }],
    [{ ...valid, commissionPercentBps: "250" }],
    [{ ...valid, commissionPercentBps: Infinity }],
    [{ ...valid, storeId: "nope" }],
  ])("400 for %j", async (body) => {
    expect((await put(body)).status).toBe(400);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("saves a percentage commission with its per-currency minimum", async () => {
    ddb.on(UpdateCommand).resolves({});
    const body = { ...valid, commissionMode: "PERCENT", commissionPercentBps: 3_000 };
    const res = await put(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...saved, commissionMode: "PERCENT", commissionPercentBps: 3_000 });
  });

  it("allows zero commission", async () => {
    ddb.on(UpdateCommand).resolves({});
    expect((await put({ ...valid, salesCommissions: { USD: 0, CAD: 0, AUD: 0 } })).status).toBe(200);
  });

  it("404 for a store that doesn't exist", async () => {
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "no", $metadata: {} }));
    const res = await put(valid);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("STORE_NOT_FOUND");
  });
});

describe("GET /admin/get-store-admin-settings/:storeId", () => {
  it("returns the saved block", async () => {
    ddb.on(GetCommand).resolves({ Item: { pk: "x", admin: saved } });
    expect((await getAdmin()).body).toEqual(saved);
  });

  it("returns a saved percentage block", async () => {
    const pct = { ...saved, commissionMode: "PERCENT", commissionPercentBps: 250 };
    ddb.on(GetCommand).resolves({ Item: { pk: "x", admin: pct } });
    expect((await getAdmin()).body).toEqual(pct);
  });

  it("reads a pre-5.1b block (or a bad mode/percentage) as FIXED with 0%", async () => {
    ddb.on(GetCommand).resolves({ Item: { pk: "x", admin: { salesCommissions: fees, suspended: true } } });
    expect((await getAdmin()).body).toEqual(saved);
    ddb.on(GetCommand).resolves({
      Item: { pk: "x", admin: { commissionMode: "TIERED", commissionPercentBps: 9_999, salesCommissions: fees, suspended: true } },
    });
    expect((await getAdmin()).body).toEqual(saved);
  });

  it("turns a flat pre-5.1a commission into the same amount in every currency", async () => {
    ddb.on(GetCommand).resolves({ Item: { pk: "x", admin: { salesCommission: 3, suspended: true } } });
    expect((await getAdmin()).body).toEqual(block({ salesCommissions: { USD: 300, CAD: 300, AUD: 300 }, suspended: true }));
  });

  it("fills in defaults for a store saved before the block existed", async () => {
    ddb.on(GetCommand).resolves({ Item: { pk: "x" } });
    expect((await getAdmin()).body).toEqual(block({ salesCommissions: { USD: 125, CAD: 125, AUD: 125 }, suspended: false }));
  });

  it("404 without a store; 403 for non-admins", async () => {
    ddb.on(GetCommand).resolves({});
    expect((await getAdmin()).status).toBe(404);
    asMember();
    expect((await getAdmin()).status).toBe(403);
  });
});

describe("the admin block is hidden outside the admin area (1.6b)", () => {
  const withSettings = () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(GetCommand).resolves({
      Item: { pk: "p", sk: "s", currencies: [], general: {}, admin: { salesCommission: 9, suspended: false } },
    });
  };
  const getData = (path: string, auth = true) => {
    const r = request(app).get(`/api/v1/store/inventory/${path}/${STORE}`).set("Host", "localhost");
    return auth ? r.set("Authorization", "Bearer t") : r;
  };

  it("store members don't get it from get-data", async () => {
    withSettings();
    asMember();
    const res = await getData("get-data");
    expect(res.status).toBe(200);
    expect(res.body.settings).not.toHaveProperty("admin");
    expect(res.body.settings).toHaveProperty("general");
  });

  it("platform admins still do", async () => {
    withSettings();
    const res = await getData("get-data");
    expect(res.body.settings.admin).toEqual(block({ salesCommissions: { USD: 900, CAD: 900, AUD: 900 }, suspended: false }));
  });

  it("the public storefront never does", async () => {
    withSettings();
    const res = await getData("get-data-public", false);
    expect(res.status).toBe(200);
    expect(res.body.settings).not.toHaveProperty("admin");
  });
});

describe("platformFeeMinor (5.4c application fee)", () => {
  const q = (o: Partial<FeeQuote> = {}): FeeQuote => ({
    currency: "CAD",
    subtotalMinor: 5000,
    discountMinor: 0,
    pricesIncludeTax: false,
    taxPercent: 0,
    totalMinor: 5000,
    ...o,
  });

  describe("FIXED", () => {
    const admin = block({ salesCommissions: { USD: 125, CAD: 200, AUD: 0 }, suspended: false }) as any;
    it("is the store's commission in the charge's currency", () => {
      expect(platformFeeMinor(admin, q())).toBe(200);
      expect(platformFeeMinor(admin, q({ currency: "AUD" }))).toBe(0);
    });
    it("never exceeds the order total", () => {
      expect(platformFeeMinor(admin, q({ totalMinor: 150 }))).toBe(150);
      expect(platformFeeMinor(admin, q({ currency: "USD", totalMinor: 0 }))).toBe(0);
    });
    it("uses the default for a store without a saved block, or one saved before 5.1b", () => {
      expect(platformFeeMinor(undefined, q({ currency: "USD" }))).toBe(125);
      expect(platformFeeMinor({ salesCommissions: { USD: 90, CAD: 90, AUD: 90 } } as any, q())).toBe(90);
    });
    it("ignores the percentage", () => {
      expect(platformFeeMinor({ ...admin, commissionPercentBps: 3_000 }, q())).toBe(200);
    });
  });

  describe("PERCENT", () => {
    const pct = (bps: number, min = 0) =>
      ({ commissionMode: "PERCENT", commissionPercentBps: bps, salesCommissions: { USD: min, CAD: min, AUD: min }, suspended: false }) as any;

    it("is the percentage of the items after discounts, not of delivery or added tax", () => {
      // 100.00 of items, 10.00 off, 15.00 delivery, 13% HST on top → base 90.00
      const quote = q({ subtotalMinor: 10_000, discountMinor: 1_000, taxPercent: 13, totalMinor: 11_865 });
      expect(commissionBaseMinor(quote)).toBe(9_000);
      expect(platformFeeMinor(pct(250), quote)).toBe(225); // 2.5%
    });

    it("takes included tax out of the base", () => {
      // 113.00 of tax-inclusive items at 13% → 100.00 before tax
      const quote = q({ subtotalMinor: 11_300, pricesIncludeTax: true, taxPercent: 13, totalMinor: 11_300 });
      expect(commissionBaseMinor(quote)).toBe(10_000);
      expect(platformFeeMinor(pct(1_000), quote)).toBe(1_000);
      // QST-style rate with thousandths, half up: 1000 × 100 / 109.975 = 909.29 → 909
      expect(commissionBaseMinor(q({ subtotalMinor: 1_000, pricesIncludeTax: true, taxPercent: 9.975 }))).toBe(909);
    });

    it("rounds half up", () => {
      expect(platformFeeMinor(pct(250), q({ subtotalMinor: 1_020 }))).toBe(26); // 25.5 → 26
      expect(platformFeeMinor(pct(250), q({ subtotalMinor: 1_019 }))).toBe(25); // 25.475 → 25
      expect(platformFeeMinor(pct(1), q({ subtotalMinor: 49 }))).toBe(0); // 0.0049 → 0
    });

    it("is at least the currency's minimum, and 0% charges just the minimum", () => {
      expect(platformFeeMinor(pct(200, 50), q({ subtotalMinor: 1_000, totalMinor: 1_000 }))).toBe(50); // 2% = 20 < 50
      expect(platformFeeMinor(pct(200, 50), q({ subtotalMinor: 10_000, totalMinor: 10_000 }))).toBe(200);
      expect(platformFeeMinor(pct(0, 50), q())).toBe(50);
      expect(platformFeeMinor(pct(0, 0), q())).toBe(0);
    });

    it("never exceeds the order total, even at the 30% cap with a minimum", () => {
      expect(platformFeeMinor(pct(3_000, 500), q({ subtotalMinor: 300, totalMinor: 300 }))).toBe(300);
      expect(platformFeeMinor(pct(3_000), q({ subtotalMinor: 0, totalMinor: 0 }))).toBe(0);
    });

    it("stays exact for large orders", () => {
      const quote = q({ subtotalMinor: 9_000_000_000_001, totalMinor: 9_000_000_000_001 });
      expect(platformFeeMinor(pct(3_000), quote)).toBe(2_700_000_000_000);
    });

    it("clamps a bad stored percentage to 0 instead of trusting it", () => {
      expect(platformFeeMinor(pct(9_999, 10), q())).toBe(10);
      expect(platformFeeMinor(pct(-500, 10), q())).toBe(10);
    });
  });
});
