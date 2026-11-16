import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// The feature is on (prod-like): set before config loads.
vi.hoisted(() => {
  process.env.CUSTOM_DOMAIN_DISTRIBUTION_ID = "EDIST123";
  process.env.CUSTOM_DOMAIN_CONNECTION_GROUP_ID = "cg_1";
  process.env.CUSTOM_DOMAIN_TARGET = "domains.ceseelia.com";
});

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  findUserIdByCognitoId: vi.fn(async () => "USER1"),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getMembership: vi.fn(),
  getStoreOverviewRow: vi.fn(async () => ({ storeSlug: "northern-hoop" })),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/store", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/store")>()),
  getStoreAdminSettings: vi.fn(),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/domain", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/domain")>()),
  createStoreDomain: vi.fn(),
  getStoreDomain: vi.fn(),
  saveStoreDomain: vi.fn(async () => true),
  removeStoreDomain: vi.fn(async () => {}),
  queueTenantCleanup: vi.fn(async () => {}),
  listDomainIndex: vi.fn(async () => []),
  listTenantCleanups: vi.fn(async () => []),
  finishTenantCleanup: vi.fn(async () => {}),
  setCleanupCertificate: vi.fn(async () => {}),
}));
vi.mock("../layers/aws/cloudfront/tenants", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/cloudfront/tenants")>()),
  createTenant: vi.fn(async () => ({ tenantId: "TEN1" })),
  getTenant: vi.fn(),
  getTenantCertificate: vi.fn(),
  setTenantEnabled: vi.fn(async () => {}),
  useTenantCertificate: vi.fn(async () => {}),
  deleteTenant: vi.fn(async () => {}),
  deleteCertificate: vi.fn(async () => true),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { getMembership } from "../layers/aws/dynamodb/dynamo-entities/membership";
import { getStoreAdminSettings } from "../layers/aws/dynamodb/dynamo-entities/store";
import {
  StoreDomain,
  createStoreDomain,
  DomainTakenError,
  finishTenantCleanup,
  listDomainIndex,
  listTenantCleanups,
  queueTenantCleanup,
  removeStoreDomain,
  saveStoreDomain,
} from "../layers/aws/dynamodb/dynamo-entities/domain";
import {
  DomainInUseError,
  createTenant,
  deleteCertificate,
  deleteTenant,
  getTenant,
  getTenantCertificate,
  setTenantEnabled,
  useTenantCertificate,
} from "../layers/aws/cloudfront/tenants";
import { certificateState, hostError, normalizeHost, pointsAtUs, tenantName } from "../layers/core/custom-domain";
import { setLiveCustomDomains, slugFromCustomOrigin, storeUrl } from "../layers/core/store-url";
import { advanceDomain, refreshLiveDomains, sweepCustomDomains } from "../layers/custom-domains";
import { buildCorsOptions, createApp } from "../app";

const STORE = "01JBZ0000000000000000000AA";
const NOW = 1_800_000_000_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const domain = (over: Partial<StoreDomain> = {}): StoreDomain => ({
  storeId: STORE,
  host: "shop.example.com",
  status: "PENDING_DNS",
  reason: "DNS_NOT_FOUND",
  dnsSeen: [],
  tenantId: null,
  tenantName: null,
  certificateArn: null,
  createdAt: NOW - HOUR,
  stepAt: NOW - HOUR,
  checkedAt: 0,
  activeAt: null,
  disabledAt: null,
  updatedAt: NOW - HOUR,
  ...over,
});
const plan = (p: "SPARK" | "NONE") =>
  vi.mocked(getStoreAdminSettings).mockResolvedValue({ admin: {} as never, lifecycle: { status: p === "NONE" ? "DRAFT" : "LIVE", plan: p } as never });
const deps = (cnames: string[], hasPlan = true) => ({ lookupCname: vi.fn(async () => cnames), storeHasPlan: vi.fn(async () => hasPlan) });
const tenant = (over = {}) => ({ exists: true, enabled: true, deployed: true, domainActive: false, certificateArn: null as string | null, etag: "E1", ...over });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveStoreDomain).mockResolvedValue(true);
  setLiveCustomDomains([]);
});

describe("custom domains: rules (9.8 phase 2)", () => {
  it("normalizes what people paste", () => {
    expect(normalizeHost(" https://Shop.Example.com/path?x=1 ")).toBe("shop.example.com");
    expect(normalizeHost("shop.example.com.")).toBe("shop.example.com");
    expect(normalizeHost("shop.example.com:443")).toBe("shop.example.com");
  });

  it("only a subdomain of someone else's domain", () => {
    expect(hostError("shop.example.com")).toBeNull();
    expect(hostError("www.shop.example.co.uk")).toBeNull();
    expect(hostError("example.com")).toBe("APEX");
    expect(hostError("x.ceseelia.com")).toBe("OURS");
    expect(hostError("d1.cloudfront.net")).toBe("OURS");
    expect(hostError("shop..example.com")).toBe("INVALID");
    expect(hostError("-shop.example.com")).toBe("INVALID");
    expect(hostError("10.0.0.1")).toBe("INVALID");
    expect(hostError("")).toBe("INVALID");
  });

  it("the CNAME must point at our target (case and trailing dot don't matter)", () => {
    expect(pointsAtUs(["Domains.Ceseelia.com."])).toBe(true);
    expect(pointsAtUs(["shops.myshopify.com"])).toBe(false);
    expect(pointsAtUs([])).toBe(false);
  });

  it("tenant names are unique and valid for CloudFront", () => {
    const n = tenantName("prod", STORE, NOW);
    expect(n).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9-.]{1,126}[a-zA-Z0-9]$/);
    expect(n).not.toBe(tenantName("prod", STORE, NOW + 1));
  });

  it("certificate states", () => {
    expect(certificateState("issued")).toBe("ISSUED");
    expect(certificateState("pending-validation")).toBe("PENDING");
    expect(certificateState("validation-timed-out")).toBe("FAILED");
    expect(certificateState(undefined)).toBe("PENDING");
  });

  it("a live domain wins in links and passes CORS; others don't", () => {
    expect(storeUrl("northern-hoop", "/order/X", { template: "https://{slug}.ceseelia.com" })).toBe("https://northern-hoop.ceseelia.com/order/X");
    setLiveCustomDomains([{ host: "shop.example.com", slug: "northern-hoop" }]);
    expect(storeUrl("northern-hoop", "/order/X", { template: "https://{slug}.ceseelia.com" })).toBe("https://shop.example.com/order/X");
    expect(storeUrl("northern-hoop")).toBe("https://shop.example.com/");
    expect(storeUrl("northern-hoop", "", { ownDomain: false, template: "https://{slug}.ceseelia.com" })).toBe("https://northern-hoop.ceseelia.com/");
    expect(slugFromCustomOrigin("https://shop.example.com")).toBe("northern-hoop");
    expect(slugFromCustomOrigin("http://shop.example.com")).toBeNull();

    const origin = buildCorsOptions(["https://app.ceseelia.com"], false, "https://{slug}.ceseelia.com").origin as (
      o: string | undefined,
      cb: (e: Error | null, ok?: boolean) => void
    ) => void;
    const allowed = (o: string) => new Promise((r) => origin(o, (_e, ok) => r(ok)));
    return Promise.all([
      expect(allowed("https://shop.example.com")).resolves.toBe(true),
      expect(allowed("https://evil.example.com")).resolves.toBe(false),
    ]);
  });
});

describe("custom domains: one step at a time", () => {
  it("DNS seen → a tenant with a managed certificate → PENDING_CERT", async () => {
    const r = await advanceDomain(domain(), NOW, deps(["domains.ceseelia.com"]));
    expect(createTenant).toHaveBeenCalledWith(expect.stringMatching(/^cs-/), "shop.example.com");
    expect(r.domain).toMatchObject({ status: "PENDING_CERT", tenantId: "TEN1", reason: null, stepAt: NOW });
    expect(saveStoreDomain).toHaveBeenCalledOnce();
  });

  it("no CNAME / the wrong one: keeps waiting, says what it saw; nothing created", async () => {
    let r = await advanceDomain(domain(), NOW, deps([]));
    expect(r.changed).toBe(false); // already DNS_NOT_FOUND with nothing seen
    r = await advanceDomain(domain(), NOW, deps(["shops.myshopify.com"]));
    expect(r.domain).toMatchObject({ status: "PENDING_DNS", reason: "DNS_WRONG_TARGET", dnsSeen: ["shops.myshopify.com"] });
    expect(createTenant).not.toHaveBeenCalled();
  });

  it("7 days without the CNAME → FAILED", async () => {
    const r = await advanceDomain(domain({ stepAt: NOW - 8 * DAY }), NOW, deps([]));
    expect(r.domain).toMatchObject({ status: "FAILED", reason: "DNS_TIMEOUT" });
  });

  it("a name CloudFront already serves elsewhere → IN_USE, still waiting", async () => {
    vi.mocked(createTenant).mockRejectedValueOnce(new DomainInUseError());
    const r = await advanceDomain(domain(), NOW, deps(["domains.ceseelia.com"]));
    expect(r.domain).toMatchObject({ status: "PENDING_DNS", reason: "IN_USE" });
  });

  it("certificate issued and domain active → ACTIVE", async () => {
    vi.mocked(getTenant).mockResolvedValue(tenant({ domainActive: true, certificateArn: "arn:cert" }));
    vi.mocked(getTenantCertificate).mockResolvedValue({ status: "issued", arn: "arn:cert" });
    const r = await advanceDomain(domain({ status: "PENDING_CERT", tenantId: "TEN1", reason: null }), NOW, deps([]));
    expect(r.domain).toMatchObject({ status: "ACTIVE", certificateArn: "arn:cert", activeAt: NOW });
  });

  it("certificate issued but the tenant still on the shared one: switch it, stay PENDING_CERT", async () => {
    vi.mocked(getTenant).mockResolvedValue(tenant());
    vi.mocked(getTenantCertificate).mockResolvedValue({ status: "issued", arn: "arn:cert" });
    const pending = domain({ status: "PENDING_CERT", tenantId: "TEN1", reason: null });
    let r = await advanceDomain(pending, NOW, deps([]));
    expect(useTenantCertificate).toHaveBeenCalledWith("TEN1", "arn:cert");
    expect(r.domain).toMatchObject({ status: "PENDING_CERT", certificateArn: "arn:cert" });

    // Switched, CloudFront still activating: nothing more to do.
    vi.mocked(useTenantCertificate).mockClear();
    vi.mocked(getTenant).mockResolvedValue(tenant({ certificateArn: "arn:cert" }));
    r = await advanceDomain(r.domain!, NOW + 60_000, deps([]));
    expect(useTenantCertificate).not.toHaveBeenCalled();
    expect(r.changed).toBe(false);

    // A change still deploying: wait for it before switching.
    vi.mocked(getTenant).mockResolvedValue(tenant({ deployed: false }));
    await advanceDomain(pending, NOW, deps([]));
    expect(useTenantCertificate).not.toHaveBeenCalled();
  });

  it("certificate failed or 72 hours → FAILED, the tenant queued for clean-up", async () => {
    vi.mocked(getTenant).mockResolvedValue(tenant());
    vi.mocked(getTenantCertificate).mockResolvedValue({ status: "failed", arn: "arn:cert" });
    let r = await advanceDomain(domain({ status: "PENDING_CERT", tenantId: "TEN1" }), NOW, deps([]));
    expect(r.domain).toMatchObject({ status: "FAILED", reason: "CERT_FAILED", tenantId: null });
    expect(queueTenantCleanup).toHaveBeenCalledWith("TEN1", "arn:cert", NOW);

    vi.mocked(getTenantCertificate).mockResolvedValue({ status: "pending-validation", arn: null });
    r = await advanceDomain(domain({ status: "PENDING_CERT", tenantId: "TEN1", stepAt: NOW - 73 * HOUR }), NOW, deps([]));
    expect(r.domain).toMatchObject({ status: "FAILED", reason: "CERT_TIMEOUT" });
  });

  it("plan ended: a live domain is switched off (DISABLED); one being set up is dropped", async () => {
    vi.mocked(getTenant).mockResolvedValue(tenant());
    let r = await advanceDomain(domain({ status: "ACTIVE", tenantId: "TEN1" }), NOW, deps([], false));
    expect(setTenantEnabled).toHaveBeenCalledWith("TEN1", "E1", false);
    expect(r.domain).toMatchObject({ status: "DISABLED", reason: "PLAN_ENDED", disabledAt: NOW });

    r = await advanceDomain(domain(), NOW, deps(["domains.ceseelia.com"], false));
    expect(r.domain).toBeNull();
    expect(removeStoreDomain).toHaveBeenCalled();
    expect(createTenant).not.toHaveBeenCalled();
  });

  it("a plan again → back on; 30 days without → removed", async () => {
    vi.mocked(getTenant).mockResolvedValue(tenant({ enabled: false }));
    let r = await advanceDomain(domain({ status: "DISABLED", tenantId: "TEN1", disabledAt: NOW - DAY }), NOW, deps([], true));
    expect(setTenantEnabled).toHaveBeenCalledWith("TEN1", "E1", true);
    expect(r.domain).toMatchObject({ status: "ACTIVE", disabledAt: null });

    r = await advanceDomain(domain({ status: "DISABLED", tenantId: "TEN1", disabledAt: NOW - 31 * DAY }), NOW, deps([], false));
    expect(r.domain).toBeNull();
    expect(removeStoreDomain).toHaveBeenCalled();
  });

  it("someone changed it meanwhile: the new tenant isn't kept", async () => {
    vi.mocked(saveStoreDomain).mockResolvedValueOnce(false);
    await advanceDomain(domain(), NOW, deps(["domains.ceseelia.com"]));
    expect(queueTenantCleanup).toHaveBeenCalledWith("TEN1", null, NOW);
  });
});

describe("custom domains: the sweep", () => {
  it("removed tenants: disable, then delete once deployed, then the certificate", async () => {
    vi.mocked(listTenantCleanups).mockResolvedValue([{ tenantId: "TEN1", certificateArn: "arn:cert", createdAt: NOW }]);
    vi.mocked(getTenant).mockResolvedValueOnce(tenant());
    await sweepCustomDomains(NOW);
    expect(setTenantEnabled).toHaveBeenCalledWith("TEN1", "E1", false);
    expect(deleteTenant).not.toHaveBeenCalled();

    vi.mocked(getTenant).mockResolvedValueOnce(tenant({ enabled: false, deployed: true }));
    await sweepCustomDomains(NOW);
    expect(deleteTenant).toHaveBeenCalledWith("TEN1", "E1");

    vi.mocked(getTenant).mockResolvedValueOnce(tenant({ exists: false }));
    await sweepCustomDomains(NOW);
    expect(deleteCertificate).toHaveBeenCalledWith("arn:cert");
    expect(finishTenantCleanup).toHaveBeenCalledWith("TEN1");
  });

  it("the live list maps live hosts to the stores' current slugs", async () => {
    vi.mocked(listDomainIndex).mockResolvedValue([
      { storeId: STORE, host: "shop.example.com", status: "ACTIVE" },
      { storeId: "01JBZ0000000000000000000BB", host: "wait.example.com", status: "PENDING_CERT" },
    ]);
    expect(await refreshLiveDomains()).toBe(1);
    expect(storeUrl("northern-hoop")).toBe("https://shop.example.com/");
  });
});

describe("custom domain routes", () => {
  const app = createApp();
  const asStoreAdmin = () => {
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "sub-1", "cognito:groups": [] } as never);
    vi.mocked(getMembership).mockResolvedValue({ storeId: STORE, userId: "USER1", role: "ADMIN", createdAt: 1 } as never);
  };
  const set = (host: string) =>
    request(app).post("/api/v1/store/domain/set").set("Host", "localhost").set("Authorization", "Bearer x").send({ storeId: STORE, host });

  it("refuses a bare domain and ours, before anything is saved", async () => {
    asStoreAdmin();
    plan("SPARK");
    expect((await set("example.com")).body.code).toBe("APEX_DOMAIN");
    expect((await set("x.ceseelia.com")).body.code).toBe("OUR_DOMAIN");
    expect(createStoreDomain).not.toHaveBeenCalled();
  });

  it("needs a plan", async () => {
    asStoreAdmin();
    plan("NONE");
    const res = await set("shop.example.com");
    expect([res.status, res.body.code]).toEqual([402, "PLAN_REQUIRED"]);
  });

  it("saves it and checks DNS at once; a taken host is 409", async () => {
    asStoreAdmin();
    plan("SPARK");
    vi.mocked(createStoreDomain).mockResolvedValueOnce(domain({ checkedAt: 0, updatedAt: NOW }));
    const res = await set("https://Shop.Example.com/");
    expect(res.status).toBe(201);
    expect(createStoreDomain).toHaveBeenCalledWith(STORE, "shop.example.com", expect.any(Number));
    expect(res.body).toMatchObject({ target: "domains.ceseelia.com", available: true, domain: { host: "shop.example.com" } });

    vi.mocked(createStoreDomain).mockRejectedValueOnce(new DomainTakenError());
    const taken = await set("shop2.example.com");
    expect([taken.status, taken.body.code]).toEqual([409, "DOMAIN_TAKEN"]);
  });

  it("public lookup: a live host → its slug; anything else 404", async () => {
    setLiveCustomDomains([{ host: "shop.example.com", slug: "northern-hoop" }]);
    const ok = await request(app).get("/api/v1/store/public/domain/shop.example.com").set("Host", "localhost");
    expect([ok.status, ok.body.slug]).toEqual([200, "northern-hoop"]);
    const no = await request(app).get("/api/v1/store/public/domain/other.example.com").set("Host", "localhost");
    expect(no.status).toBe(404);
  });
});
