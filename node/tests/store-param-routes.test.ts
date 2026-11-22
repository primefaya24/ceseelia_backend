import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { ulid } from "ulid";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";
import { StoreItem, StoreItemVariant, StoreParamDef } from "../layers/core/interfaces/store";
import { itemParamFromDef } from "../layers/core/store-params";
import { withVariantTotals } from "../layers/core/variants";

/*
 * Stage R routes: POST /store/parameter/save, DELETE /store/parameter/delete, and create-item
 * taking linked params from the store (R.3, R.4). DynamoDB is a small in-memory table.
 */

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);
const app = createApp();
const STORE = ulid();
const CAT = ulid();
const PK = `STORE#${STORE}`;

let rows: Map<string, Record<string, any>>;
const k = (pk: string, sk: string) => `${pk}|${sk}`;
const put = (sk: string, v: object) => rows.set(k(PK, sk), { pk: PK, sk, ...structuredClone(v) });
const get = (sk: string) => rows.get(k(PK, sk));

const shape = (over: Partial<StoreParamDef> = {}): StoreParamDef => ({
  storeParamId: ulid(),
  storeParamName: "Shape",
  storeParamTag: "",
  storeParamType: "SINGLE_SELECT",
  storeParamIsMandatory: true,
  storeParamOptions: ["Coffin", "Square"],
  storeParamHasVariants: false,
  ...over,
});

const item = (id: string, def: StoreParamDef | null, over: Partial<StoreItem> = {}): StoreItem =>
  withVariantTotals({
    storeItemId: id,
    storeItemCategoryId: CAT,
    storeItemImageUris: [],
    storeItemName: "Nails " + id.slice(-4),
    storeItemStock: 4,
    storeItemPrices: { CAD: 3500 },
    storeItemDescription: "",
    storeItemIsActive: true,
    storeItemHashtagIds: [],
    storeItemDiscountPercent: 0,
    storeItemCustomParams: def ? [itemParamFromDef(def)] : [],
    storeItemVariants: [],
    ...over,
  });

const row = (o: Record<string, string>, stock: number): StoreItemVariant => ({
  storeVariantOptions: o,
  storeVariantStock: stock,
  storeVariantPrices: { CAD: 3500 },
  storeVariantIsActive: true,
});

let failNextItemUpdate = 0;

beforeEach(() => {
  ddb.reset();
  s3.reset();
  rows = new Map();
  failNextItemUpdate = 0;
  put("SETTINGS", { storeInfo: {} });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "admin-1", "cognito:groups": ["Admins"] });

  ddb.on(QueryCommand).callsFake((input) => {
    const prefix = input.ExpressionAttributeValues?.[":sk_prefix"] ?? "";
    const pk = input.ExpressionAttributeValues?.[":pk"];
    return { Items: [...rows.values()].filter((r) => r.pk === pk && String(r.sk).startsWith(prefix)).map((r) => structuredClone(r)) };
  });
  ddb.on(GetCommand).callsFake((input) => {
    const r = rows.get(k(input.Key.pk, input.Key.sk));
    return { Item: r ? structuredClone(r) : undefined };
  });
  ddb.on(PutCommand).callsFake((input) => {
    const exists = rows.has(k(input.Item.pk, input.Item.sk));
    if (input.ConditionExpression === "attribute_exists(pk)" && !exists) {
      throw new ConditionalCheckFailedException({ message: "no", $metadata: {} });
    }
    rows.set(k(input.Item.pk, input.Item.sk), structuredClone(input.Item));
    return {};
  });
  ddb.on(TransactWriteCommand).callsFake((input) => {
    for (const t of input.TransactItems) {
      if (t.Put) rows.set(k(t.Put.Item.pk, t.Put.Item.sk), structuredClone(t.Put.Item));
      if (t.Update?.UpdateExpression?.startsWith("SET storeItemId")) {
        const v = t.Update.ExpressionAttributeValues;
        const sk = t.Update.Key.sk;
        rows.set(k(PK, sk), {
          ...(rows.get(k(PK, sk)) ?? { pk: PK, sk }),
          storeItemId: v[":storeItemId"],
          storeItemCategoryId: v[":storeItemCategoryId"],
          storeItemName: v[":storeItemName"],
          storeItemStock: v[":storeItemStock"],
          storeItemPrices: v[":storeItemPrices"],
          storeItemCustomParams: v[":storeItemCustomParams"],
          storeItemVariants: v[":storeItemVariants"],
        });
      }
    }
    return {};
  });
  ddb.on(UpdateCommand).callsFake((input) => {
    const r = rows.get(k(input.Key.pk, input.Key.sk));
    if (input.UpdateExpression === "SET #p = :p, #v = :v, #s = :s, #pr = :pr") {
      const v = input.ExpressionAttributeValues;
      if (failNextItemUpdate > 0) {
        failNextItemUpdate--;
        // A paid order lowered the stock meanwhile.
        r!.storeItemStock = r!.storeItemStock - 1;
        throw new ConditionalCheckFailedException({ message: "changed", $metadata: {} });
      }
      if (!r || JSON.stringify(r.storeItemCustomParams) !== JSON.stringify(v[":op"]) || r.storeItemStock !== v[":os"]) {
        throw new ConditionalCheckFailedException({ message: "changed", $metadata: {} });
      }
      Object.assign(r, { storeItemCustomParams: v[":p"], storeItemVariants: v[":v"], storeItemStock: v[":s"], storeItemPrices: v[":pr"] });
    }
    return {};
  });
  ddb.on(DeleteCommand).callsFake((input) => {
    rows.delete(k(input.Key.pk, input.Key.sk));
    return {};
  });
});

const save = (body: object) =>
  request(app).post("/api/v1/store/parameter/save").set("Host", "localhost").set("Authorization", "Bearer good").send({ storeId: STORE, ...body });
const del = (paramId: string) =>
  request(app).delete(`/api/v1/store/parameter/delete/${STORE}/${paramId}`).set("Host", "localhost").set("Authorization", "Bearer good");

describe("POST /store/parameter/save", () => {
  it("creates one with a new id, trimmed", async () => {
    const res = await save({ isUpdate: false, param: { ...shape(), storeParamId: "", storeParamName: " Shape ", storeParamOptions: [" Coffin ", "", "Square"] } });
    expect(res.status).toBe(200);
    const id = res.body.param.storeParamId;
    expect(id).toMatch(/^[0-9A-Z]{26}$/);
    expect(get(`PARAM#${id}`)).toMatchObject({ storeParamName: "Shape", storeParamOptions: ["Coffin", "Square"] });
  });

  it("400 for a bad parameter; variants asked on multiple choice are switched off", async () => {
    expect((await save({ isUpdate: false, param: shape({ storeParamOptions: [] }) })).status).toBe(400);
    expect((await save({ isUpdate: false, param: shape({ storeParamName: "A#B" }) })).status).toBe(400);
    expect((await save({ isUpdate: false, param: shape({ storeParamOptions: ["Long", "long"] }) })).status).toBe(400);
    const multi = await save({ isUpdate: false, param: shape({ storeParamType: "MULTI_SELECT", storeParamHasVariants: true }) });
    expect(multi.status).toBe(200);
    expect(multi.body.param.storeParamHasVariants).toBe(false);
  });

  it("409 PARAM_KEY_TAKEN for the same name and tag ignoring case; a tag makes it different", async () => {
    const a = shape({ storeParamName: "Size" });
    put(`PARAM#${a.storeParamId}`, a);
    const taken = await save({ isUpdate: false, param: shape({ storeParamName: "size" }) });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("PARAM_KEY_TAKEN");
    expect((await save({ isUpdate: false, param: shape({ storeParamName: "Size", storeParamTag: "Rings" }) })).status).toBe(200);
  });

  it("409 PARAM_LIMIT at 50", async () => {
    for (let i = 0; i < 50; i++) {
      const d = shape({ storeParamName: `P${i}` });
      put(`PARAM#${d.storeParamId}`, d);
    }
    const res = await save({ isUpdate: false, param: shape({ storeParamName: "One more" }) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PARAM_LIMIT");
  });

  it("404 updating one that doesn't exist", async () => {
    expect((await save({ isUpdate: true, param: shape() })).status).toBe(404);
  });

  it("an update rewrites every item using it and leaves the others alone", async () => {
    const d = shape();
    put(`PARAM#${d.storeParamId}`, d);
    const a = ulid(), b = ulid(), c = ulid();
    put(`ITEM#${a}`, item(a, d));
    put(`ITEM#${b}`, item(b, d));
    put(`ITEM#${c}`, item(c, null));
    const res = await save({ isUpdate: true, param: { ...d, storeParamOptions: ["Coffin", "Squoval", "Almond"] }, renames: { Square: "Squoval" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ itemsUpdated: 2, itemsFailed: 0 });
    expect(get(`ITEM#${a}`)!.storeItemCustomParams[0].storeParamOptions).toEqual(["Coffin", "Squoval", "Almond"]);
    expect(get(`ITEM#${b}`)!.storeItemCustomParams[0].storeParamOptions).toEqual(["Coffin", "Squoval", "Almond"]);
    expect(get(`ITEM#${c}`)!.storeItemCustomParams).toEqual([]);
    expect(get(`PARAM#${d.storeParamId}`)!.storeParamOptions).toEqual(["Coffin", "Squoval", "Almond"]);
    // Live stores' items get an AI check queued, like an item save.
    expect([...rows.values()].filter((r) => r.pk === "APP_ITEM_CHECK")).toHaveLength(2);
  });

  it("variant rows follow a rename, keeping stock", async () => {
    const d = shape({ storeParamHasVariants: true });
    put(`PARAM#${d.storeParamId}`, d);
    const a = ulid();
    put(`ITEM#${a}`, item(a, d, { storeItemVariants: [row({ Shape: "Coffin" }, 2), row({ Shape: "Square" }, 7)] }));
    const res = await save({ isUpdate: true, param: { ...d, storeParamOptions: ["Coffin", "Squoval"] }, renames: { Square: "Squoval" } });
    expect(res.status).toBe(200);
    expect(get(`ITEM#${a}`)!.storeItemVariants).toEqual([row({ Shape: "Coffin" }, 2), row({ Shape: "Squoval" }, 7)]);
    expect(get(`ITEM#${a}`)!.storeItemStock).toBe(9);
  });

  it("409 PARAM_BREAKS_ITEMS and nothing written when an item would break", async () => {
    const d = shape({ storeParamName: "Shape", storeParamHasVariants: true });
    const other = shape({ storeParamName: "Nail shape" });
    put(`PARAM#${d.storeParamId}`, d);
    put(`PARAM#${other.storeParamId}`, other);
    const a = ulid();
    const both = withVariantTotals({ ...item(a, d, { storeItemVariants: [row({ Shape: "Coffin" }, 1), row({ Shape: "Square" }, 1)] }) });
    both.storeItemCustomParams.push(itemParamFromDef(other));
    put(`ITEM#${a}`, both);
    // Renaming "Shape" to the other parameter's name collides on this item.
    const res = await save({ isUpdate: true, param: { ...d, storeParamName: "Nail shape", storeParamTag: "v2" } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PARAM_BREAKS_ITEMS");
    expect(res.body.items).toEqual([{ itemId: a, itemName: both.storeItemName, problem: "NAME_ON_ITEM" }]);
    expect(get(`PARAM#${d.storeParamId}`)!.storeParamName).toBe("Shape");
  });

  it("retries an item a paid order changed meanwhile, from what's stored", async () => {
    const d = shape({ storeParamHasVariants: false });
    put(`PARAM#${d.storeParamId}`, d);
    const a = ulid();
    put(`ITEM#${a}`, item(a, d));
    failNextItemUpdate = 1;
    const res = await save({ isUpdate: true, param: { ...d, storeParamOptions: ["Coffin", "Square", "Oval"] } });
    expect(res.body).toMatchObject({ itemsUpdated: 1, itemsFailed: 0 });
    expect(get(`ITEM#${a}`)!.storeItemStock).toBe(3); // the order's decrement survived
    expect(get(`ITEM#${a}`)!.storeItemCustomParams[0].storeParamOptions).toEqual(["Coffin", "Square", "Oval"]);
  });
});

describe("DELETE /store/parameter/delete", () => {
  it("takes it off every item, then deletes it", async () => {
    const d = shape({ storeParamHasVariants: true });
    put(`PARAM#${d.storeParamId}`, d);
    const a = ulid();
    put(`ITEM#${a}`, item(a, d, { storeItemVariants: [row({ Shape: "Coffin" }, 2), row({ Shape: "Square" }, 3)] }));
    const res = await del(d.storeParamId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ itemsUpdated: 1, itemsFailed: 0 });
    expect(get(`ITEM#${a}`)).toMatchObject({ storeItemCustomParams: [], storeItemVariants: [], storeItemStock: 5 });
    expect(get(`PARAM#${d.storeParamId}`)).toBeUndefined();
  });

  it("a parameter no item uses", async () => {
    const d = shape();
    put(`PARAM#${d.storeParamId}`, d);
    expect((await del(d.storeParamId)).body).toEqual({ itemsUpdated: 0, itemsFailed: 0 });
    expect(get(`PARAM#${d.storeParamId}`)).toBeUndefined();
  });
});

describe("create-item with linked params (R.4)", () => {
  const send = (storeItem: StoreItem, isUpdate = false) =>
    request(app)
      .post("/api/v1/store/inventory/create-item")
      .set("Host", "localhost")
      .set("Authorization", "Bearer good")
      .send({ storeId: STORE, isUpdate, storeItemId: isUpdate ? storeItem.storeItemId : "", storeItem });

  beforeEach(() => put(`CATEGORY#${CAT}`, { storeCategoriyId: CAT }));

  it("takes the store's copy, whatever the client sent", async () => {
    const d = shape();
    put(`PARAM#${d.storeParamId}`, d);
    const sent = item(ulid(), d);
    sent.storeItemCustomParams[0] = { ...sent.storeItemCustomParams[0], storeParamOptions: ["Fake"], storeParamLabel: "Fake" };
    const res = await send(sent);
    expect(res.status).toBe(200);
    expect(get(`ITEM#${res.text}`)!.storeItemCustomParams).toEqual([itemParamFromDef(d)]);
  });

  it("400 PARAM_NOT_FOUND for a deleted parameter", async () => {
    const res = await send(item(ulid(), shape()));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PARAM_NOT_FOUND");
  });

  it("400 for the same parameter twice", async () => {
    const d = shape();
    put(`PARAM#${d.storeParamId}`, d);
    const twice = item(ulid(), d);
    twice.storeItemCustomParams.push({ ...twice.storeItemCustomParams[0], storeParamLabel: "Other" });
    expect((await send(twice)).status).toBe(400);
  });

  it("an item-only param (before Stage R) still saves as sent", async () => {
    const legacy = item(ulid(), null, {
      storeItemCustomParams: [{ storeParamLabel: "Gift", storeParamType: "MULTI_SELECT", storeParamIsMandatory: false, storeParamOptions: ["Wrap"] }],
    });
    const res = await send(legacy);
    expect(res.status).toBe(200);
    expect(get(`ITEM#${res.text}`)!.storeItemCustomParams[0].storeParamLabel).toBe("Gift");
  });
});
