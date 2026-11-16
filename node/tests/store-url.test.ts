import { describe, expect, it } from "vitest";
import { buildCorsOptions } from "../app";
import { RESERVED_SLUGS, isValidSlug } from "../constants/slug";
import { slugFromStoreOrigin, storeOriginPattern, storeUrl } from "../layers/core/store-url";
import { orderSessionParams } from "../layers/payments/order-checkout";

const PROD = "https://{slug}.ceseelia.com";
const WEBAPP = "https://app.ceseelia.com";

function originAllowed(options: ReturnType<typeof buildCorsOptions>, origin: string | undefined) {
  return new Promise<boolean>((resolve) => {
    if (options.origin === true) return resolve(true);
    (options.origin as any)(origin, (_err: unknown, allow: boolean) => resolve(allow));
  });
}

describe("storeUrl (9.8 phase 1)", () => {
  it("is the store's subdomain with a template", () => {
    const opts = { template: PROD, webappUrl: WEBAPP };
    expect(storeUrl("northern-hoop", "", opts)).toBe("https://northern-hoop.ceseelia.com/");
    expect(storeUrl("northern-hoop", "/order/01X?paid=1", opts)).toBe("https://northern-hoop.ceseelia.com/order/01X?paid=1");
    expect(storeUrl("northern-hoop", "/?item=01Y", opts)).toBe("https://northern-hoop.ceseelia.com/?item=01Y");
  });

  it("is /s/<slug> under the app without one", () => {
    const opts = { template: "", webappUrl: "http://localhost:4200/" };
    expect(storeUrl("northern-hoop", "", opts)).toBe("http://localhost:4200/s/northern-hoop");
    expect(storeUrl("northern-hoop", "/checkout?cancelled=1", opts)).toBe("http://localhost:4200/s/northern-hoop/checkout?cancelled=1");
    expect(storeUrl("northern-hoop", "/?item=01Y", opts)).toBe("http://localhost:4200/s/northern-hoop?item=01Y");
  });

  it("works with a local template with a port", () => {
    expect(storeUrl("merch-two", "/checkout", { template: "http://{slug}.localhost:4200" })).toBe("http://merch-two.localhost:4200/checkout");
    expect(slugFromStoreOrigin("http://merch-two.localhost:4200", "http://{slug}.localhost:4200")).toBe("merch-two");
  });

  it("is the address Stripe sends the shopper back to", () => {
    // The test stage has no template: the /s/ form (prod uses the subdomain, same code path).
    const p = orderSessionParams({
      orderId: "01ORDER", storeId: "01STORE", storeSlug: "northern-hoop",
      quote: { lines: [], totalMinor: 0, deliveryMinor: 0, taxMinor: 0, taxLines: [], currency: "CAD" } as never, feeMinor: 0, customerEmail: "a@b.co", now: 0,
    });
    expect(p.success_url).toBe(`${storeUrl("northern-hoop", "/order/01ORDER?paid=1")}`);
    expect(p.cancel_url).toBe(`${storeUrl("northern-hoop", "/checkout?cancelled=01ORDER")}`);
  });
});

describe("slugFromStoreOrigin", () => {
  it("reads the slug from a store origin only", () => {
    expect(slugFromStoreOrigin("https://northern-hoop.ceseelia.com", PROD)).toBe("northern-hoop");
    expect(slugFromStoreOrigin("https://Northern-Hoop.ceseelia.com", PROD)).toBe("northern-hoop");
    expect(slugFromStoreOrigin("http://northern-hoop.ceseelia.com", PROD)).toBeNull(); // not https
    expect(slugFromStoreOrigin("https://a.b.ceseelia.com", PROD)).toBeNull(); // one level only
    expect(slugFromStoreOrigin("https://northern-hoop.ceseelia.com.evil.example", PROD)).toBeNull();
    expect(slugFromStoreOrigin("https://evilceseelia.com", PROD)).toBeNull();
    expect(slugFromStoreOrigin("https://-bad.ceseelia.com", PROD)).toBeNull();
    expect(slugFromStoreOrigin("https://northern-hoop.ceseelia.com", "")).toBeNull();
    expect(storeOriginPattern("")).toBeNull();
  });
});

describe("CORS with store subdomains", () => {
  const opts = buildCorsOptions([WEBAPP], false, PROD);

  it("allows the app and every valid store subdomain", async () => {
    expect(await originAllowed(opts, WEBAPP)).toBe(true);
    expect(await originAllowed(opts, "https://northern-hoop.ceseelia.com")).toBe(true);
  });

  it("refuses reserved names, other domains and look-alikes", async () => {
    expect(await originAllowed(opts, "https://admin.ceseelia.com")).toBe(false);
    expect(await originAllowed(opts, "https://ab.ceseelia.com")).toBe(false); // shorter than a slug
    expect(await originAllowed(opts, "https://northern-hoop.ceseelia.com.evil.example")).toBe(false);
    expect(await originAllowed(opts, "https://evil.example")).toBe(false);
  });

  it("without a template only the list counts", async () => {
    const plain = buildCorsOptions([WEBAPP], false, "");
    expect(await originAllowed(plain, "https://northern-hoop.ceseelia.com")).toBe(false);
  });
});

describe("reserved slugs (subdomain names)", () => {
  it("keeps infrastructure names for ourselves", () => {
    for (const s of ["app", "api", "dev", "www", "storage", "prod", "mail", "shop", "domains", "assets", "auth"]) {
      expect(RESERVED_SLUGS.has(s)).toBe(true);
      expect(isValidSlug(s)).toBe(false);
    }
    expect(isValidSlug("northern-hoop")).toBe(true);
  });
});
