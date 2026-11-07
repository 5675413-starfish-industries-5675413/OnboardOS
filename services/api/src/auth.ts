/**
 * auth.ts — Extract and validate authorizer claims from API Gateway context.
 *
 * API Gateway HTTP API JWT authorizers verify the token signature and
 * expiry *before* invoking the Lambda. The Lambda therefore receives
 * pre-verified claims in `event.requestContext.authorizer.jwt.claims`.
 *
 * What this module adds on top of Gateway verification:
 *  1. Confirms token_use === "access" — rejects ID tokens.
 *     Access tokens carry the user sub; ID tokens carry identity claims.
 *     The architecture freeze (AR-05) mandates access tokens for API calls.
 *  2. Extracts `sub` as the canonical userSub — never trust client-provided
 *     user IDs or role claims in request bodies/query strings.
 *  3. Exposes preferred_username / email for display-only purposes.
 *
 * IMPORTANT: This module does NOT re-verify the JWT signature. That is
 * performed by the API Gateway JWT authorizer. If this Lambda is ever
 * invoked without going through the authorizer (e.g. direct Lambda invoke
 * in tests), callers are responsible for providing a pre-validated context.
 */

import type { APIGatewayProxyEventV2 } from "aws-lambda";

export interface AuthContext {
  /** Cognito user sub — stable, immutable primary identity. */
  userSub: string;
  /** Display name: preferred_username if set, otherwise email, otherwise sub. */
  username: string;
}

export class AuthError extends Error {
  constructor(
    public readonly code: "NO_AUTHORIZER" | "NOT_ACCESS_TOKEN" | "NO_SUB",
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Extract a validated AuthContext from the API Gateway event.
 * Throws AuthError if the context is missing or the token_use is wrong.
 */
export function extractAuthContext(event: APIGatewayProxyEventV2): AuthContext {
  const claims = (event.requestContext as {
    authorizer?: { jwt?: { claims?: Record<string, string> } };
  })?.authorizer?.jwt?.claims;

  if (!claims) {
    throw new AuthError(
      "NO_AUTHORIZER",
      "Request did not pass through JWT authorizer — no claims present",
    );
  }

  // Enforce access token usage. Cognito access tokens have token_use=access.
  // ID tokens have token_use=id. Accepting ID tokens here would allow a caller
  // to use a less-scrutinised token type and bypass scope-based checks.
  const tokenUse = claims["token_use"];
  if (tokenUse !== "access") {
    throw new AuthError(
      "NOT_ACCESS_TOKEN",
      `token_use must be 'access', got '${tokenUse ?? "undefined"}'`,
    );
  }

  const sub = claims["sub"];
  if (!sub) {
    throw new AuthError("NO_SUB", "Access token missing 'sub' claim");
  }

  // Prefer preferred_username, fall back to email, then sub.
  const username =
    claims["preferred_username"] ?? claims["email"] ?? claims["username"] ?? sub;

  return { userSub: sub, username };
}
