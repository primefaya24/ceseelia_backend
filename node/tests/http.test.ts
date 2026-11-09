import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { Request, Response } from "express";
import request from "supertest";

vi.mock("../layers/aws/cognito", () => ({
  verifyCognitoAccessToken: vi.fn(),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { extractAccessToken, getAuth, validateAndExecuteHttpApiRoute } from "../layers/core/http";

const verifyMock = vi.mocked(verifyCognitoAccessToken);

type Opts = {
  pure?: (req: Request) => boolean;
  valid?: (req: Request) => boolean;
  core?: (req: Request, res: Response) => Promise<void> | void;
  withAuth?: boolean;
  adminOnly?: boolean;
};

function appWith(opts: Opts = {}) {
  const app = express();
  app.use(express.json());
  app.all("/t", (req, res) => {
    validateAndExecuteHttpApiRoute(
      req,
      res,
      opts.pure ?? (() => true),
      opts.valid ?? (() => true),
      opts.core ?? ((_r, s) => void s.send(getAuth(s))),
      opts.withAuth ?? true,
      opts.adminOnly ?? false
    );
  });
  return app;
}

beforeEach(() => {
  verifyMock.mockReset();
});

describe("extractAccessToken", () => {
  it("accepts raw and Bearer tokens", () => {
    expect(extractAccessToken({ headers: { authorization: "abc" } } as Request)).toBe("abc");
    expect(extractAccessToken({ headers: { authorization: "Bearer abc" } } as Request)).toBe("abc");
    expect(extractAccessToken({ headers: {} } as Request)).toBeNull();
    expect(extractAccessToken({ headers: { authorization: "  " } } as Request)).toBeNull();
  });
});

describe("validateAndExecuteHttpApiRoute", () => {
  it("returns 401 when the token is missing", async () => {
    const res = await request(appWith()).get("/t");
    expect(res.status).toBe(401);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("returns 401 when the token fails verification", async () => {
    verifyMock.mockRejectedValue(new Error("bad signature"));
    const res = await request(appWith()).get("/t").set("Authorization", "forged");
    expect(res.status).toBe(401);
  });

  it("attaches identity from the verified claims", async () => {
    verifyMock.mockResolvedValue({ sub: "user-1", "cognito:groups": ["Admins"] });
    const res = await request(appWith()).get("/t").set("Authorization", "Bearer good");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cognitoId: "user-1", groups: ["Admins"], isAdmin: true });
  });

  it("returns 403 for non-admins on admin-only routes", async () => {
    verifyMock.mockResolvedValue({ sub: "user-1" });
    const res = await request(appWith({ adminOnly: true })).get("/t").set("Authorization", "good");
    expect(res.status).toBe(403);
  });

  it("authenticates before validating params", async () => {
    const pure = vi.fn(() => false);
    const res = await request(appWith({ pure })).get("/t");
    expect(res.status).toBe(401);
    expect(pure).not.toHaveBeenCalled();
  });

  it("returns 400 for impure or invalid params, including checks that throw", async () => {
    verifyMock.mockResolvedValue({ sub: "u" });
    const impure = await request(appWith({ pure: () => false })).get("/t").set("Authorization", "t");
    expect(impure.status).toBe(400);
    expect(impure.body.message).toBe("Bad request parameters");

    const invalid = await request(appWith({ valid: () => false })).get("/t").set("Authorization", "t");
    expect(invalid.status).toBe(400);
    expect(invalid.body.message).toBe("Invalid request parameters");

    const throwing = await request(appWith({ pure: (r) => r.body.missing.length > 0 }))
      .get("/t")
      .set("Authorization", "t");
    expect(throwing.status).toBe(400);
  });

  it("returns 500 instead of hanging when the route core throws", async () => {
    verifyMock.mockResolvedValue({ sub: "u" });
    const core = async () => {
      throw new Error("boom");
    };
    const res = await request(appWith({ core })).get("/t").set("Authorization", "t");
    expect(res.status).toBe(500);
  });

  it("skips auth for public routes", async () => {
    const res = await request(appWith({ withAuth: false, core: (_r, s) => void s.send("ok") })).get("/t");
    expect(res.status).toBe(200);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  describe("identity can't be spoofed through the body (S.12)", () => {
    const spoof = { cognito_id: "victim", is_user_admin: true, cognito_groups: ["Admins"], cognito_token: "x" };
    const echoBody = (r: Request, s: Response) => void s.send({ body: r.body, locals: s.locals });

    it("strips identity keys from the body on public routes", async () => {
      const res = await request(appWith({ withAuth: false, core: echoBody })).post("/t").send({ ...spoof, keep: 1 });
      expect(res.status).toBe(200);
      expect(res.body.body).toEqual({ keep: 1 });
      expect(res.body.locals).toEqual({});
    });

    it("getAuth refuses on a public route", async () => {
      const res = await request(appWith({ withAuth: false })).post("/t").send(spoof);
      expect(res.status).toBe(500);
    });

    it("a body claiming admin doesn't pass the admin gate", async () => {
      verifyMock.mockResolvedValue({ sub: "user-1", "cognito:groups": [] });
      const res = await request(appWith({ adminOnly: true })).post("/t").set("Authorization", "good").send(spoof);
      expect(res.status).toBe(403);
    });

    it("signed-in identity comes from the token, not the body, and the token isn't kept", async () => {
      verifyMock.mockResolvedValue({ sub: "user-1", "cognito:groups": [] });
      const res = await request(appWith({ core: echoBody })).post("/t").set("Authorization", "Bearer good").send(spoof);
      expect(res.body.locals.auth).toEqual({ cognitoId: "user-1", groups: [], isAdmin: false });
      expect(res.body.body).toEqual({});
      expect(JSON.stringify(res.body)).not.toContain("good");
    });
  });
});
