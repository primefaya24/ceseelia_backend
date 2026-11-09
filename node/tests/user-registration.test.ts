import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AdminGetUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

vi.mock("../layers/aws/cognito", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyCognitoAccessToken: vi.fn(),
}));

import { verifyCognitoAccessToken } from "../layers/aws/cognito";
import { createApp } from "../app";
import { createUserRecordsFromCognito, fetchUserUUID, ProfileNotFoundError } from "../layers/aws/dynamodb/dynamo-entities/user";

const ddb = mockClient(DynamoDBDocumentClient);
const cognito = mockClient(CognitoIdentityProviderClient);
const SUB = "3478b4d8-8081-7007-c763-e74fec7e348a";

const attrs = (patch: Record<string, string> = {}) => ({
  sub: SUB,
  email: " New@Example.com ",
  email_verified: "true",
  ...patch,
});
const cognitoUser = (patch: Record<string, string> = {}) => ({
  Username: SUB,
  UserAttributes: Object.entries(attrs(patch)).map(([Name, Value]) => ({ Name, Value })),
});

// Route queries by index: CognitoIdentifierGSI (lookup by sub), UserEmailGSI (lookup by email),
// or the user's own rows (getMyProfile).
function tableWith({ cognitoRows = [] as any[], emailRows = [] as any[], profileRows = [] as any[] } = {}) {
  ddb.on(QueryCommand).callsFake((input) => {
    if (input.IndexName === "CognitoIdentifierGSI") return { Items: cognitoRows };
    if (input.IndexName === "UserEmailGSI") return { Items: emailRows };
    if (input.ExpressionAttributeValues[":sk_prefix"] === "STORE#") return { Items: [] }; // memberships
    return { Items: structuredClone(profileRows) }; // getMyProfile deletes pk/sk from what it gets
  });
}

beforeEach(() => {
  ddb.reset();
  cognito.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(verifyCognitoAccessToken).mockResolvedValue({ sub: SUB, "cognito:groups": [] });
});

describe("createUserRecordsFromCognito (same rows as the OnUserRegister Lambda)", () => {
  it("creates INFO, COGNITO_DATA and NOTIFICATION_SETTINGS in one transaction", async () => {
    tableWith();
    ddb.on(TransactWriteCommand).resolves({});
    const userId = await createUserRecordsFromCognito(attrs({ "custom:userName": "Ada Lovelace" }));

    const items = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!.map((t) => t.Put!);
    expect(items.every((p) => p.ConditionExpression === "attribute_not_exists(pk)")).toBe(true);
    const [info, cog, notif] = items.map((p) => p.Item!);
    expect(info).toMatchObject({
      pk: `USER#${userId}`,
      sk: "PROFILE#INFO",
      userEmailAddress: "new@example.com",
      userFirstName: "Ada",
      userLastName: "Lovelace",
      userAvatarUri: "",
      userPreferredLocale: "en",
      isProfileComplete: false,
    });
    expect(info).not.toHaveProperty("userPlan"); // the Lambda doesn't write it
    expect(cog).toEqual({
      pk: `USER#${userId}`,
      sk: `PROFILE#COGNITO_DATA#${SUB}`,
      userSocialProviderName: "",
      userSocialProviderType: "",
      userSocialProviderUserId: "",
      userEmail: "new@example.com",
      userCognitoId: SUB,
      userDeactivated: false,
    });
    expect(notif).toEqual({ pk: `USER#${userId}`, sk: "PROFILE#NOTIFICATION_SETTINGS", userFcmToken: "" });
  });

  it("links a new identity to the existing user with the same verified email", async () => {
    tableWith({ emailRows: [{ pk: "USER#EXISTING", sk: "PROFILE#COGNITO_DATA#other-sub", userEmail: "new@example.com" }] });
    ddb.on(PutCommand).resolves({});
    expect(await createUserRecordsFromCognito(attrs())).toBe("EXISTING");
    expect(ddb.commandCalls(PutCommand)[0].args[0].input.Item).toMatchObject({
      pk: "USER#EXISTING",
      sk: `PROFILE#COGNITO_DATA#${SUB}`,
    });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("writes nothing when the email isn't verified", async () => {
    expect(await createUserRecordsFromCognito(attrs({ email_verified: "false" }))).toBeNull();
    expect(await createUserRecordsFromCognito(attrs({ email: "" }))).toBeNull();
    expect(ddb.calls()).toHaveLength(0);
  });
});

describe("fetchUserUUID", () => {
  it("throws ProfileNotFoundError when there are no rows", async () => {
    tableWith();
    await expect(fetchUserUUID(SUB)).rejects.toThrow(ProfileNotFoundError);
  });
});

describe("GET /user/get-my-profile", () => {
  const app = createApp();
  const getProfile = () =>
    request(app).get("/api/v1/user/get-my-profile").set("Host", "localhost").set("Authorization", "Bearer good");
  const infoRow = { pk: "USER#U1", sk: "PROFILE#INFO", userEmailAddress: "a@b.co" };

  it("returns the profile when the Lambda already created it (no Cognito call)", async () => {
    tableWith({ cognitoRows: [{ pk: "USER#U1", userDeactivated: false }], profileRows: [infoRow] });
    const res = await getProfile();
    expect(res.status).toBe(200);
    expect(res.body.info).toMatchObject({ userId: "U1", userIsAdmin: false });
    expect(res.body.stores).toEqual([]);
    expect(cognito.calls()).toHaveLength(0);
  });

  it("creates the missing rows from the user pool, then returns the profile", async () => {
    tableWith({ profileRows: [infoRow] });
    cognito.on(AdminGetUserCommand).resolves(cognitoUser());
    ddb.on(TransactWriteCommand).resolves({});
    const res = await getProfile();
    expect(res.status).toBe(200);
    expect(cognito.commandCalls(AdminGetUserCommand)[0].args[0].input.Username).toBe(SUB);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it("returns 404 PROFILE_NOT_FOUND when the email isn't verified", async () => {
    tableWith();
    cognito.on(AdminGetUserCommand).resolves(cognitoUser({ email_verified: "false" }));
    const res = await getProfile();
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PROFILE_NOT_FOUND");
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("returns 404 PROFILE_NOT_FOUND when the user isn't in the pool", async () => {
    tableWith();
    cognito.on(AdminGetUserCommand).rejects(Object.assign(new Error("gone"), { name: "UserNotFoundException" }));
    const res = await getProfile();
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PROFILE_NOT_FOUND");
  });

  it("returns 404 when the rows exist but INFO is missing", async () => {
    tableWith({ cognitoRows: [{ pk: "USER#U1", userDeactivated: false }], profileRows: [] });
    const res = await getProfile();
    expect(res.status).toBe(404);
  });

  it("returns 403 ACCOUNT_DEACTIVATED for a deactivated account", async () => {
    tableWith({ cognitoRows: [{ pk: "USER#U1", userDeactivated: true }] });
    const res = await getProfile();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_DEACTIVATED");
  });

  it("returns 500 (not 404) when the user pool can't be reached", async () => {
    tableWith();
    cognito.on(AdminGetUserCommand).rejects(new Error("network"));
    const res = await getProfile();
    expect(res.status).toBe(500);
  });

  it("other user routes answer 404 for a missing profile too", async () => {
    tableWith();
    const res = await request(app)
      .put("/api/v1/user/update-fcm-token")
      .set("Host", "localhost")
      .set("Authorization", "Bearer good")
      .send({ fcmToken: "t" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("PROFILE_NOT_FOUND");
  });
});
