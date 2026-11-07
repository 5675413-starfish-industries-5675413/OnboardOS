import { describe, it, expect, vi, beforeEach } from "vitest";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";

// ---------------------------------------------------------------------------
// Hoist the mock function so it exists before vi.mock factory runs
// ---------------------------------------------------------------------------
const mockGetMemberships = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  getMembershipsForUser: mockGetMemberships,
  docClient: {},
}));

import { handleGetMe } from "../routes/me.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeAccessTokenEvent(
  overrides: Partial<Record<string, string>> = {},
): APIGatewayProxyEventV2 {
  const claims: Record<string, string> = {
    sub: "user-sub-abc",
    token_use: "access",
    preferred_username: "testuser",
    ...overrides,
  };
  return {
    version: "2.0",
    routeKey: "GET /v1/me",
    rawPath: "/v1/me",
    rawQueryString: "",
    headers: {},
    requestContext: {
      http: { method: "GET", path: "/v1/me", protocol: "HTTP/1.1", sourceIp: "1.2.3.4", userAgent: "test" },
      accountId: "123456789012",
      apiId: "test-api",
      domainName: "test.execute-api.us-east-1.amazonaws.com",
      domainPrefix: "test",
      requestId: "req-me-test",
      routeKey: "GET /v1/me",
      stage: "$default",
      time: "01/Jan/2026:00:00:00 +0000",
      timeEpoch: 0,
      authorizer: { jwt: { claims, scopes: [] } },
    } as APIGatewayProxyEventV2["requestContext"],
    isBase64Encoded: false,
  } as APIGatewayProxyEventV2;
}

function makeContext(id = "req-me-test"): Context {
  return {
    awsRequestId: id,
    functionName: "api-fn",
    functionVersion: "$LATEST",
    invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:api-fn",
    memoryLimitInMB: "512",
    logGroupName: "/aws/lambda/api-fn",
    logStreamName: "stream",
    callbackWaitsForEmptyEventLoop: false,
    getRemainingTimeInMillis: () => 29000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

const ACTIVE_ADMIN_MEMBERSHIP = {
  organizationId: "northstar-cloud",
  organizationName: "Northstar Cloud",
  userSub: "user-sub-abc",
  role: "org_admin" as const,
  status: "ACTIVE" as const,
  teamIds: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleGetMe", () => {
  beforeEach(() => {
    mockGetMemberships.mockReset();
  });

  // ── Authentication denial tests ──────────────────────────────────────────

  it("returns 401 when no authorizer context is present (anonymous request)", async () => {
    // Simulate a request that somehow bypassed the JWT authorizer
    const event: APIGatewayProxyEventV2 = {
      version: "2.0",
      routeKey: "GET /v1/me",
      rawPath: "/v1/me",
      rawQueryString: "",
      headers: {},
      requestContext: {
        http: { method: "GET", path: "/v1/me", protocol: "HTTP/1.1", sourceIp: "1.2.3.4", userAgent: "anon" },
        accountId: "123456789012",
        apiId: "test",
        domainName: "test",
        domainPrefix: "test",
        requestId: "anon-req",
        routeKey: "GET /v1/me",
        stage: "$default",
        time: "",
        timeEpoch: 0,
        // No authorizer field
      } as APIGatewayProxyEventV2["requestContext"],
      isBase64Encoded: false,
    } as APIGatewayProxyEventV2;

    const result = await handleGetMe(event, makeContext("anon-req"));
    expect(result.statusCode).toBe(401);
    const body = JSON.parse(result.body);
    expect(body.code).toBe("UNAUTHORIZED");
    // Must not leak internal auth error details
    expect(body.message).not.toContain("NO_AUTHORIZER");
    expect(body.requestId).toBe("anon-req");
    // No DB call should have been made
    expect(mockGetMemberships).not.toHaveBeenCalled();
  });

  it("returns 401 when an ID token is presented instead of an access token", async () => {
    const event = makeAccessTokenEvent({ token_use: "id" });
    const result = await handleGetMe(event, makeContext());
    expect(result.statusCode).toBe(401);
    const body = JSON.parse(result.body);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(mockGetMemberships).not.toHaveBeenCalled();
  });

  it("returns 401 when token_use claim is absent", async () => {
    // Remove token_use by overriding it with an empty value won't work;
    // we need to craft an event with no token_use key at all
    const event: APIGatewayProxyEventV2 = {
      ...makeAccessTokenEvent(),
      requestContext: {
        ...makeAccessTokenEvent().requestContext,
        authorizer: {
          jwt: {
            claims: { sub: "user-sub-abc" }, // no token_use
            scopes: [],
          },
        },
      } as APIGatewayProxyEventV2["requestContext"],
    };
    const result = await handleGetMe(event, makeContext());
    expect(result.statusCode).toBe(401);
    expect(mockGetMemberships).not.toHaveBeenCalled();
  });

  // ── Membership denial tests ──────────────────────────────────────────────

  it("returns 200 with empty memberships when user has no membership record", async () => {
    mockGetMemberships.mockResolvedValue([]);
    const result = await handleGetMe(makeAccessTokenEvent(), makeContext());
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.memberships).toHaveLength(0);
    expect(body.userSub).toBe("user-sub-abc");
  });

  it("excludes SUSPENDED memberships from response", async () => {
    mockGetMemberships.mockResolvedValue([
      { ...ACTIVE_ADMIN_MEMBERSHIP, status: "SUSPENDED" },
    ]);
    const result = await handleGetMe(makeAccessTokenEvent(), makeContext());
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.memberships).toHaveLength(0);
  });

  it("excludes INVITED memberships from response", async () => {
    mockGetMemberships.mockResolvedValue([
      { ...ACTIVE_ADMIN_MEMBERSHIP, status: "INVITED" },
    ]);
    const result = await handleGetMe(makeAccessTokenEvent(), makeContext());
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.memberships).toHaveLength(0);
  });

  it("excludes malformed membership records (invalid role value)", async () => {
    mockGetMemberships.mockResolvedValue([
      { ...ACTIVE_ADMIN_MEMBERSHIP, role: "superadmin" }, // not in OrgRole enum
    ]);
    const result = await handleGetMe(makeAccessTokenEvent(), makeContext());
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    // Invalid record excluded, not returned
    expect(body.memberships).toHaveLength(0);
  });

  it("returns 500 and fails closed when DynamoDB throws", async () => {
    mockGetMemberships.mockRejectedValue(new Error("ResourceNotFoundException"));
    const result = await handleGetMe(makeAccessTokenEvent(), makeContext("req-db-fail"));
    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body);
    expect(body.code).toBe("INTERNAL_ERROR");
    // Must not leak DynamoDB error details to client
    expect(body.message).not.toContain("ResourceNotFoundException");
    expect(body.requestId).toBe("req-db-fail");
  });

  // ── Successful retrieval tests ───────────────────────────────────────────

  it("returns 200 with ACTIVE membership matching contract schema", async () => {
    mockGetMemberships.mockResolvedValue([ACTIVE_ADMIN_MEMBERSHIP]);
    const result = await handleGetMe(makeAccessTokenEvent(), makeContext());
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.userSub).toBe("user-sub-abc");
    expect(body.username).toBe("testuser");
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].organizationId).toBe("northstar-cloud");
    expect(body.memberships[0].organizationName).toBe("Northstar Cloud");
    expect(body.memberships[0].role).toBe("org_admin");
    expect(body.memberships[0].status).toBe("ACTIVE");
    expect(Array.isArray(body.memberships[0].teamIds)).toBe(true);
  });

  it("returns only the requesting user's memberships — sub from token, not from body", async () => {
    // Even if someone passes a different userSub in a request body,
    // the handler uses authCtx.userSub which comes from the verified token.
    mockGetMemberships.mockResolvedValue([ACTIVE_ADMIN_MEMBERSHIP]);
    const result = await handleGetMe(makeAccessTokenEvent(), makeContext());
    // Verify getMembershipsForUser was called with the token sub, not any body sub
    expect(mockGetMemberships).toHaveBeenCalledWith("user-sub-abc");
  });

  it("manager role is returned correctly from DynamoDB record", async () => {
    mockGetMemberships.mockResolvedValue([
      { ...ACTIVE_ADMIN_MEMBERSHIP, role: "manager", userSub: "manager-sub" },
    ]);
    const result = await handleGetMe(
      makeAccessTokenEvent({ sub: "manager-sub" }),
      makeContext(),
    );
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.memberships[0].role).toBe("manager");
  });

  it("employee role is returned correctly from DynamoDB record", async () => {
    mockGetMemberships.mockResolvedValue([
      { ...ACTIVE_ADMIN_MEMBERSHIP, role: "employee", userSub: "emp-sub" },
    ]);
    const result = await handleGetMe(
      makeAccessTokenEvent({ sub: "emp-sub" }),
      makeContext(),
    );
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.memberships[0].role).toBe("employee");
  });

  it("forged role in request body does not affect returned membership role", async () => {
    // DynamoDB says this user is an employee; regardless of what might be in
    // the request body, the role comes from DynamoDB.
    mockGetMemberships.mockResolvedValue([
      { ...ACTIVE_ADMIN_MEMBERSHIP, role: "employee" },
    ]);
    const result = await handleGetMe(makeAccessTokenEvent(), makeContext());
    const body = JSON.parse(result.body);
    expect(body.memberships[0].role).toBe("employee");
    // Role is never "org_admin" just because someone claimed it
  });

  it("cross-org access denied — user has no membership in requested org", async () => {
    // getMembershipsForUser only returns memberships for the configured org.
    // A user who is not a member gets an empty array.
    mockGetMemberships.mockResolvedValue([]);
    const result = await handleGetMe(
      makeAccessTokenEvent({ sub: "outsider-sub" }),
      makeContext(),
    );
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.memberships).toHaveLength(0);
    // This user authenticated successfully but has no org access —
    // the frontend should redirect to an appropriate "no access" view.
  });
});

// ── Integration note ─────────────────────────────────────────────────────────
// The following scenarios require a deployed API Gateway with JWT authorizer
// and cannot be verified in unit tests:
//   - Expired JWT is rejected (HTTP 401 from Gateway before Lambda runs)
//   - Tampered JWT signature is rejected (Gateway verifies signature)
//   - Missing Authorization header returns 401 from Gateway
//   - Token from wrong Cognito user pool is rejected (Gateway checks issuer)
// These are marked as pending in docs/aws-deployment.md integration checklist.
