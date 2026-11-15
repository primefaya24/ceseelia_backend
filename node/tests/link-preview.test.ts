import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../layers/aws/dynamodb/dynamo-entities/slug", async (orig) => ({
  ...(await orig<object>()),
  getSlugOwner: vi.fn(),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/store", async (orig) => ({
  ...(await orig<object>()),
  getStorePreview: vi.fn(),
  getPublicStoreItem: vi.fn(),
}));

import { createApp } from "../app";
import { getSlugOwner } from "../layers/aws/dynamodb/dynamo-entities/slug";
import { getPublicStoreItem, getStorePreview } from "../layers/aws/dynamodb/dynamo-entities/store";
import { escapeHtml, previewText } from "../api/v1/store/public/preview";

const app = createApp();
const STORE = "01JBZ0000000000000000000AA";
const ITEM = "01JBZ0000000000000000000XT";
const get = (path: string) => request(app).get(`/api/v1/store/public/preview/${path}`).set("Host", "localhost");
const meta = (html: string, prop: string) => html.match(new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`))?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSlugOwner).mockResolvedValue(STORE);
  vi.mocked(getStorePreview).mockResolvedValue({ storeName: "Northern Hoop", slogan: "Hoops & more", logoUri: "store/A/logo.png", live: true });
});

describe("link previews (L.9 / WA 3.6)", () => {
  it("a store: its name, slogan and logo, the store link, cached 5 minutes", async () => {
    const res = await get("northern-hoop");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    expect(meta(res.text, "og:title")).toBe("Northern Hoop");
    expect(meta(res.text, "og:description")).toBe("Hoops &amp; more");
    expect(meta(res.text, "og:image")).toMatch(/^https:\/\/.+\/store\/A\/logo\.png$/);
    expect(meta(res.text, "og:url")).toMatch(/\/s\/northern-hoop$/);
    expect(meta(res.text, "twitter:card")).toBe("summary_large_image");
  });

  it("an item: its name, description and first photo, with the item link", async () => {
    vi.mocked(getPublicStoreItem).mockResolvedValue({
      item: { storeItemName: "Pink Slay", storeItemDescription: "A pink hoop", storeItemImageUris: ["store/A/i1.png"] },
    } as never);
    const res = await get(`northern-hoop/${ITEM}`);
    expect(meta(res.text, "og:title")).toBe("Pink Slay · Northern Hoop");
    expect(meta(res.text, "og:type")).toBe("product");
    expect(meta(res.text, "og:image")).toMatch(/i1\.png$/);
    expect(meta(res.text, "og:url")).toMatch(new RegExp(`/s/northern-hoop\\?item=${ITEM}$`));
  });

  it("a hidden item, or any item of a store that isn't live, shows the store", async () => {
    vi.mocked(getPublicStoreItem).mockResolvedValue(null);
    expect(meta((await get(`northern-hoop/${ITEM}`)).text, "og:title")).toBe("Northern Hoop");
    vi.mocked(getStorePreview).mockResolvedValue({ storeName: "Draft Co", slogan: "", logoUri: "", live: false });
    const res = await get(`draft-co/${ITEM}`);
    expect(getPublicStoreItem).toHaveBeenCalledTimes(1);
    expect(meta(res.text, "og:description")).toBe("Draft Co is coming soon.");
    expect(meta(res.text, "twitter:card")).toBe("summary");
    expect(res.text).not.toContain("og:image");
  });

  it("unknown or suspended: a plain Ceseelia preview, 404", async () => {
    vi.mocked(getSlugOwner).mockResolvedValueOnce(null);
    const res = await get("nobody-here");
    expect(res.status).toBe(404);
    expect(meta(res.text, "og:title")).toBe("Ceseelia");
    vi.mocked(getStorePreview).mockResolvedValueOnce(null);
    expect((await get("northern-hoop")).status).toBe(404);
  });

  it("bad slugs and item ids are 400; names can't break out of the tags", async () => {
    expect((await get("ab")).status).toBe(400);
    expect((await get("admin")).status).toBe(400);
    expect((await get("northern-hoop/not-an-id")).status).toBe(400);
    vi.mocked(getStorePreview).mockResolvedValue({ storeName: '"><script>alert(1)</script>', slogan: "", logoUri: "", live: true });
    const res = await get("northern-hoop");
    expect(res.text).not.toContain("<script>");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("helpers: escaping and one-line, word-cut descriptions", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    expect(previewText("a\n\nb\tc")).toBe("a b c");
    const long = previewText("word ".repeat(100), 50);
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long.endsWith("word…")).toBe(true);
  });
});
