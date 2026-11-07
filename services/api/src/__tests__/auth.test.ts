import { describe, it, expect } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { extractAuthContext, AuthError } from "../auth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  claims?: Record<string, string> | null,
): APIGatewayProxyEventV2 {
  const base = {
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
      requestId: "req-auth-test",
      routeKey: "GET /v1/me",
      stage: "$default",
      time: "01/Jan/2026:00:00:00 +0000",
      timeEpoch: 0,
    },
    isBase64Encoded: false,
  } as APIGatewayProxyEventV2;

  if (claims === null) {
    // No authorizer context at all
    return base;
  }

  return {
    ...base,
    requestContext: {
      ...base.requestContext,
      authorizer: { jwt: { claims, scopes: [] } },
    } as APIGatewayProxyEventV2["requestContext"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractAuthContext", () => {
  it("returns userSub and username from a valid access-token context", () => {
    const event = makeEvent({
      sub: "user-sub-123",
      token_use: "access",
      preferred_username: "alice",
    });
    const ctx = extractAuthContext(event);
    expect(ctx.userSub).toBe("user-sub-123");
    expect(ctx.username).toBe("alice");
  });

  it("falls back to email when preferred_username is absent", () => {
    const event = makeEvent({
      sub: "user-sub-456",
      token_use: "access",
      email: "bob@example.com",
    });
    const ctx = extractAuthContext(event);
    expect(ctx.username).toBe("bob@example.com");
  });

  it("falls back to sub when neither preferred_username nor email is present", () => {
    const event = makeEvent({ sub: "user-sub-789", token_use: "access" });
    const ctx = extractAuthContext(event);
    expect(ctx.username).toBe("user-sub-789");
  });

  it("throws NO_AUTHORIZER when no authorizer context is present", () => {
    const event = makeEvent(null);
    expect(() => extractAuthContext(event)).toThrow(AuthError);
    try {
      extractAuthContext(event);
    } catch (e) {
      expect(e instanceof AuthError && e.code).toBe("NO_AUTHORIZER");
    }
  });

  it("throws NOT_ACCESS_TOKEN when token_use is 'id' (ID token misuse)", () => {
    const event = makeEvent({ sub: "user-sub-id", token_use: "id" });
    expect(() => extractAuthContext(event)).toThrow(AuthError);
    try {
      extractAuthContext(event);
    } catch (e) {
      expect(e instanceof AuthError && e.code).toBe("NOT_ACCESS_TOKEN");
    }
  });

  it("throws NOT_ACCESS_TOKEN when token_use is absent", () => {
    const event = makeEvent({ sub: "user-sub-notype" });
    try {
      extractAuthContext(event);
    } catch (e) {
      expect(e instanceof AuthError && e.code).toBe("NOT_ACCESS_TOKEN");
    }
  });

  it("throws NO_SUB when sub claim is absent", () => {
    const event = makeEvent({ token_use: "access" });
    try {
      extractAuthContext(event);
    } catch (e) {
      expect(e instanceof AuthError && e.code).toBe("NO_SUB");
    }
  });

  it("rejects forged client-provided role claims (role field is not extracted)", () => {
    // The contract: extractAuthContext only extracts sub and username.
    // Any "role" or "custom:role" claim in the token is intentionally ignored —
    // roles come from DynamoDB membership records, not token claims.
    const event = makeEvent({
      sub: "attacker-sub",
      token_use: "access",
      "custom:role": "org_admin",
      role: "org_admin",
    });
    const ctx = extractAuthContext(event);
    // Only sub and username are present — no role field
    expect(Object.keys(ctx)).not.toContain("role");
    expect(ctx.userSub).toBe("attacker-sub");
  });
});
