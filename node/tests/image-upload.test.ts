import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DeleteObjectTaggingCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { initStoreCategory } from "../layers/core/interfaces/store";
import { ulid } from "ulid";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";
import {
  createImageUpload,
  IMAGE_UPLOAD_MAX_BYTES,
  markImagesKept,
  parseImageType,
  parseUploadCount,
} from "../layers/aws/s3/image-upload";

const s3 = mockClient(S3Client);
const ddb = mockClient(DynamoDBDocumentClient);
const STORE = ulid();
const ID = ulid();
const app = createApp();
const get = (path: string) =>
  request(app).get(`/api/v1${path}`).set("Host", "localhost").set("Authorization", "Bearer good");
/* The signed POST policy's conditions, decoded. */
const policyOf = (fields: Record<string, string>) =>
  JSON.parse(Buffer.from(fields.Policy, "base64").toString("utf8")).conditions as unknown[];

beforeEach(() => {
  s3.reset();
  ddb.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "admin-1", "cognito:groups": ["Admins"] });
});

describe("upload params (2.3a)", () => {
  it.each([
    ["png", "png"],
    ["PNG", "png"],
    ["jpg", "jpg"],
    ["jpeg", "jpg"],
    ["gif", null],
    ["svg", null],
    ["png;x", null],
    [undefined, null],
  ])("parseImageType(%j) → %j", (raw, type) => expect(parseImageType(raw)).toBe(type));

  it.each([
    ["0", 0],
    ["10", 10],
    ["99", 99],
    ["100", null],
    ["100000", null],
    ["-1", null],
    ["1.5", null],
    ["1e3", null],
    ["", null],
  ])("parseUploadCount(%j) → %j", (raw, n) => expect(parseUploadCount(raw)).toBe(n));
});

describe("createImageUpload (2.3b)", () => {
  it("is a presigned POST capped at 5 MB, with a fixed type, key and pending tag", async () => {
    const upload = await createImageUpload(`store/${STORE}/images/logo/`, "jpg");
    expect(upload.key).toMatch(new RegExp(`^store/${STORE}/images/logo/[0-9A-Z]{26}\\.jpg$`));
    expect(upload.fields).toMatchObject({ key: upload.key, "Content-Type": "image/jpeg" });
    expect(upload.fields.tagging).toContain("<Key>ceseelia-upload</Key><Value>pending</Value>");

    const conditions = policyOf(upload.fields);
    expect(conditions).toContainEqual(["content-length-range", 1, IMAGE_UPLOAD_MAX_BYTES]);
    expect(conditions).toContainEqual(["eq", "$Content-Type", "image/jpeg"]);
    expect(conditions).toContainEqual(["eq", "$tagging", upload.fields.tagging]);
    expect(conditions).toContainEqual({ key: upload.key });
  });

  it("pins a long, immutable Cache-Control on the object (3.2: keys are unique per upload)", async () => {
    const upload = await createImageUpload(`store/${STORE}/images/logo/`, "png");
    expect(upload.fields["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(policyOf(upload.fields)).toContainEqual(["eq", "$Cache-Control", "public, max-age=31536000, immutable"]);
  });
});

describe("upload routes (2.3a–c)", () => {
  it.each([
    `/store/get-logo-upload-url/${STORE}/png`,
    `/store/get-header-strip-image-upload-url/${STORE}/jpeg`,
  ])("%s → one POST slot in the store's folder", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.body.key).toMatch(new RegExp(`^store/${STORE}/images/(logo|header)/`));
    expect(res.body.fields.Policy).toBeTruthy();
  });

  it.each([
    `/store/get-logo-upload-url/${STORE}/gif`,
    `/store/get-header-strip-image-upload-url/${STORE}/svg`,
    `/store/category/get-banner-upload-url/${STORE}/${ID}/webp`,
  ])("%s → 400 for other image types", async (path) => {
    expect((await get(path)).status).toBe(400);
  });

  it("promo: grouped png/jpg slots", async () => {
    const res = await get(`/store/get-promo-image-upload-urls/${STORE}/2/1`);
    expect(res.status).toBe(200);
    expect(res.body.png).toHaveLength(2);
    expect(res.body.jpg).toHaveLength(1);
    expect(res.body.jpg[0].key).toMatch(/\.jpg$/);
  });

  it.each(["0/0", "100000/0", "6/5", "x/1", "1.5/1"])("promo %s → 400 (1–10 in total)", async (counts) => {
    expect((await get(`/store/get-promo-image-upload-urls/${STORE}/${counts}`)).status).toBe(400);
  });

  it("item: slots only for an item that exists in the store", async () => {
    ddb.on(GetCommand).resolves({ Item: { pk: `STORE#${STORE}` } });
    const ok = await get(`/store/inventory/get-item-image-upload-urls/${STORE}/${ID}/0/3`);
    expect(ok.status).toBe(200);
    expect(ok.body.jpg).toHaveLength(3);
    expect(ok.body.jpg[0].key).toMatch(new RegExp(`^store/${STORE}/item/${ID}/images/`));
    expect(ddb.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({ pk: `STORE#${STORE}`, sk: `ITEM#${ID}` });

    ddb.on(GetCommand).resolves({});
    const missing = await get(`/store/inventory/get-item-image-upload-urls/${STORE}/${ID}/0/3`);
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe("Item not found");
  });

  it("item: 11 images → 400", async () => {
    expect((await get(`/store/inventory/get-item-image-upload-urls/${STORE}/${ID}/6/5`)).status).toBe(400);
  });

  it("category banner: only for a category that exists in the store", async () => {
    ddb.on(GetCommand).resolves({ Item: { pk: `STORE#${STORE}` } });
    const ok = await get(`/store/category/get-banner-upload-url/${STORE}/${ID}/png`);
    expect(ok.status).toBe(200);
    expect(ok.body.key).toMatch(new RegExp(`^store/${STORE}/category/${ID}/images/.+\\.png$`));

    ddb.on(GetCommand).resolves({});
    expect((await get(`/store/category/get-banner-upload-url/${STORE}/${ID}/png`)).status).toBe(404);
  });
});

describe("markImagesKept (2.3d)", () => {
  it("clears the pending tag once per store key, ignoring blanks and outside keys", async () => {
    s3.on(DeleteObjectTaggingCommand).resolves({});
    const a = `store/${STORE}/images/logo/a.png`;
    await markImagesKept([a, a, "", null, undefined, "https://evil/x.png", `store/${STORE}/images/promo/b.jpg`]);
    expect(s3.commandCalls(DeleteObjectTaggingCommand).map((c) => c.args[0].input.Key)).toEqual([
      a,
      `store/${STORE}/images/promo/b.jpg`,
    ]);
  });

  it("a key with no object is fine", async () => {
    s3.on(DeleteObjectTaggingCommand).rejects(Object.assign(new Error("gone"), { name: "NoSuchKey" }));
    await expect(markImagesKept([`store/${STORE}/images/logo/a.png`])).resolves.toBeUndefined();
  });

  it("any other error fails the save", async () => {
    s3.on(DeleteObjectTaggingCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    await expect(markImagesKept([`store/${STORE}/images/logo/a.png`])).rejects.toThrow("denied");
  });
});

describe("saves keep their images before writing (2.3d)", () => {
  it("category save: pending tag cleared, then the write, then the folder cleanup", async () => {
    const order: string[] = [];
    const banner = `store/${STORE}/category/${ID}/images/${ulid()}.png`;
    s3.on(DeleteObjectTaggingCommand).callsFake((input) => (order.push(`keep ${input.Key}`), {}));
    ddb.on(UpdateCommand).callsFake(() => (order.push("write"), {}));
    s3.on(ListObjectsV2Command).callsFake(() => (order.push("cleanup"), { Contents: [] }));
    const res = await request(app)
      .post("/api/v1/store/category/create")
      .set("Host", "localhost")
      .set("Authorization", "Bearer good")
      .send({
        storeId: STORE,
        categoryId: ID,
        isUpdate: true,
        storeCategory: { ...initStoreCategory("", "Drinks"), storeCategoryBannerUri: banner },
      });
    expect(res.status).toBe(200);
    expect(order).toEqual([`keep ${banner}`, "write", "cleanup"]);
  });

  it("if the tag can't be cleared, nothing is saved", async () => {
    s3.on(DeleteObjectTaggingCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    ddb.on(UpdateCommand).resolves({});
    const res = await request(app)
      .post("/api/v1/store/category/create")
      .set("Host", "localhost")
      .set("Authorization", "Bearer good")
      .send({
        storeId: STORE,
        categoryId: ID,
        isUpdate: true,
        storeCategory: {
          ...initStoreCategory("", "Drinks"),
          storeCategoryBannerUri: `store/${STORE}/category/${ID}/images/${ulid()}.png`,
        },
      });
    expect(res.status).toBe(500);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
