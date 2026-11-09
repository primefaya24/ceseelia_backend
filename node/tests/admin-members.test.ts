import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../layers/aws/cognito", () => ({ verifyCognitoAccessToken: vi.fn() }));
vi.mock("../layers/aws/ses", () => ({ sendEmail: vi.fn() }));
vi.mock("../layers/aws/dynamodb/dynamo-entities/user", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/user")>()),
  peekUserByEmail: vi.fn(),
}));
vi.mock("../layers/aws/dynamodb/dynamo-entities/membership", async (orig) => ({
  ...(await orig<typeof import("../layers/aws/dynamodb/dynamo-entities/membership")>()),
  getStoreOverviewRow: vi.fn(),
  addStoreMember: vi.fn(),
  inviteStoreMember: vi.fn(),
  removeStoreMember: vi.fn(),
  cancelStoreInvite: vi.fn(),
  listStoreMembers: vi.fn(),
  listStoreInvites: vi.fn(),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { sendEmail } from "../layers/aws/ses";
import { peekUserByEmail } from "../layers/aws/dynamodb/dynamo-entities/user";
import * as membership from "../layers/aws/dynamodb/dynamo-entities/membership";
import { MembershipError } from "../layers/aws/dynamodb/dynamo-entities/membership";
import { createApp } from "../app";

const m = vi.mocked(membership);
const app = createApp();
const STORE = "01JBZ0000000000000000000AA";
const USER = "01JBZ0000000000000000000ZZ";

type Method = "get" | "post" | "delete";
const call = (method: Method, path: string, body?: object) => {
  const r = request(app)[method](`/api/v1/admin${path}`).set("Host", "localhost").set("Authorization", "Bearer good");
  return body ? r.send(body) : r;
};
const asAdmin = () => vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "a", "cognito:groups": ["Admins"] });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  asAdmin();
  m.getStoreOverviewRow.mockResolvedValue({ storeName: "Northern <Hoop>" });
});

describe("admin member routes: access", () => {
  const ROUTES: Array<[Method, string, object | undefined]> = [
    ["get", `/get-store-members/${STORE}`, undefined],
    ["post", "/assign-store-member", { storeId: STORE, email: "a@b.co" }],
    ["delete", `/remove-store-member/${STORE}/${USER}`, undefined],
    ["delete", `/cancel-store-invite/${STORE}/a%40b.co`, undefined],
  ];

  it.each(ROUTES)("%s %s is admin-only, even for a store admin", async (method, path, body) => {
    vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: "x", "cognito:groups": [] });
    expect((await call(method, path, body)).status).toBe(403);
  });

  it.each(ROUTES)("%s %s needs a token", async (method, path, body) => {
    const r = request(app)[method](`/api/v1/admin${path}`).set("Host", "localhost");
    expect((await (body ? r.send(body) : r)).status).toBe(401);
  });
});

describe("GET /admin/get-store-members/:storeId", () => {
  it("returns members and invites", async () => {
    m.listStoreMembers.mockResolvedValue([{ userId: USER } as any]);
    m.listStoreInvites.mockResolvedValue([{ email: "x@y.co", role: "MERCHANT", createdAt: 1 }]);
    const res = await call("get", `/get-store-members/${STORE}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ members: [{ userId: USER }], invites: [{ email: "x@y.co", role: "MERCHANT", createdAt: 1 }] });
  });

  it("404 for an unknown store; 400 for a bad id", async () => {
    m.getStoreOverviewRow.mockResolvedValue(null);
    expect((await call("get", `/get-store-members/${STORE}`)).body.code).toBe("STORE_NOT_FOUND");
    expect((await call("get", "/get-store-members/nope")).status).toBe(400);
  });
});

describe("POST /admin/assign-store-member", () => {
  it("adds an existing account straight away (default role MERCHANT, email normalized)", async () => {
    vi.mocked(peekUserByEmail).mockResolvedValue([{ pk: `USER#${USER}`, sk: "PROFILE#COGNITO_DATA#s" }]);
    const res = await call("post", "/assign-store-member", { storeId: STORE, email: " Ada@X.co " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: "ADDED", userId: USER, role: "MERCHANT" });
    expect(peekUserByEmail).toHaveBeenCalledWith("ada@x.co");
    expect(m.addStoreMember).toHaveBeenCalledWith(STORE, USER, "MERCHANT");
    expect(m.inviteStoreMember).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("409 ALREADY_MEMBER", async () => {
    vi.mocked(peekUserByEmail).mockResolvedValue([{ pk: `USER#${USER}` }]);
    m.addStoreMember.mockRejectedValue(new MembershipError("ALREADY_MEMBER", "already"));
    const res = await call("post", "/assign-store-member", { storeId: STORE, email: "a@b.co", role: "ADMIN" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ALREADY_MEMBER");
  });

  it("invites an email with no account and sends the invite email", async () => {
    vi.mocked(peekUserByEmail).mockResolvedValue([]);
    vi.mocked(sendEmail).mockResolvedValue({ MessageId: "1" } as any);
    const res = await call("post", "/assign-store-member", { storeId: STORE, email: "New@X.co", role: "ADMIN" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: "INVITED", email: "new@x.co", role: "ADMIN", emailSent: true });
    expect(m.inviteStoreMember).toHaveBeenCalledWith(STORE, "new@x.co", "ADMIN");

    const [subject, , to, html] = vi.mocked(sendEmail).mock.calls[0];
    expect(to).toBe("new@x.co");
    expect(subject).toContain("Northern <Hoop>");
    expect(html).toContain("Northern &lt;Hoop&gt;"); // store name is escaped in the HTML
    expect(html).toContain('href="http://localhost:4200/auth/sign-up?email=new%40x.co"'); // prefills sign-up
  });

  it("keeps the invite and reports emailSent=false when SES fails", async () => {
    vi.mocked(peekUserByEmail).mockResolvedValue([]);
    vi.mocked(sendEmail).mockResolvedValue(undefined);
    const res = await call("post", "/assign-store-member", { storeId: STORE, email: "new@x.co" });
    expect(res.body).toMatchObject({ result: "INVITED", emailSent: false });
    expect(m.inviteStoreMember).toHaveBeenCalled();
  });

  it("404 for an unknown store, without looking up the user", async () => {
    m.getStoreOverviewRow.mockResolvedValue(null);
    const res = await call("post", "/assign-store-member", { storeId: STORE, email: "a@b.co" });
    expect(res.status).toBe(404);
    expect(peekUserByEmail).not.toHaveBeenCalled();
  });

  it.each([
    [{ storeId: "nope", email: "a@b.co" }],
    [{ storeId: STORE }],
    [{ storeId: STORE, email: "not-an-email" }],
    [{ storeId: STORE, email: "" }],
    [{ storeId: STORE, email: `${"a".repeat(250)}@b.co` }],
    [{ storeId: STORE, email: "a@b.co", role: "OWNER" }],
    [{ storeId: STORE, email: "a@b.co", role: 1 }],
  ])("400 for %j", async (body) => {
    expect((await call("post", "/assign-store-member", body)).status).toBe(400);
    expect(m.addStoreMember).not.toHaveBeenCalled();
    expect(m.inviteStoreMember).not.toHaveBeenCalled();
  });
});

describe("DELETE routes", () => {
  it("remove-store-member removes, or 404 NOT_A_MEMBER", async () => {
    expect((await call("delete", `/remove-store-member/${STORE}/${USER}`)).body).toEqual({ removed: true });
    expect(m.removeStoreMember).toHaveBeenCalledWith(STORE, USER);
    m.removeStoreMember.mockRejectedValue(new MembershipError("NOT_A_MEMBER", "no"));
    const res = await call("delete", `/remove-store-member/${STORE}/${USER}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_A_MEMBER");
    expect((await call("delete", `/remove-store-member/${STORE}/bad`)).status).toBe(400);
  });

  it("cancel-store-invite decodes the email, or 404 NOT_INVITED", async () => {
    expect((await call("delete", `/cancel-store-invite/${STORE}/New%40X.co`)).body).toEqual({ cancelled: true });
    expect(m.cancelStoreInvite).toHaveBeenCalledWith(STORE, "New@X.co");
    m.cancelStoreInvite.mockRejectedValue(new MembershipError("NOT_INVITED", "no"));
    expect((await call("delete", `/cancel-store-invite/${STORE}/a%40b.co`)).status).toBe(404);
    expect((await call("delete", `/cancel-store-invite/${STORE}/nope`)).status).toBe(400);
  });

  it("a database failure is a 500", async () => {
    m.removeStoreMember.mockRejectedValue(new Error("down"));
    expect((await call("delete", `/remove-store-member/${STORE}/${USER}`)).status).toBe(500);
  });
});
