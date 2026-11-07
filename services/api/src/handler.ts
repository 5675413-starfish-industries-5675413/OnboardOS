/**
 * OnboardOS API Lambda — HTTP routing handler.
 *
 * Public routes  (no JWT authorizer):
 *   GET /health          → Phase 1 health check
 *
 * Protected routes (API Gateway JWT authorizer required):
 *   GET /v1/me           → authenticated identity + memberships
 *
 * Route protection is enforced at the API Gateway level via a JWT authorizer.
 * Requests that do not carry a valid Cognito access token never reach this
 * Lambda for protected routes.
 *
 * The smoke-test handler lives in smokeTest.ts.
 * It is NOT wired to any API Gateway event source.
 */

import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { handleGetMe } from "./routes/me.js";

// ---------------------------------------------------------------------------
// Response type (always the structured object form)
// ---------------------------------------------------------------------------

interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function json(statusCode: number, body: unknown): HttpResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Public HTTP handler
// ---------------------------------------------------------------------------

export const httpHandler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<HttpResult> => {
  try {
    const routeKey =
      event.routeKey ??
      `${event.requestContext?.http?.method} ${event.requestContext?.http?.path}`;

    switch (routeKey) {
      // ── Public routes ──────────────────────────────────────────────────
      case "GET /health":
        return json(200, {
          status: "ok",
          service: "onboardos-api",
          timestamp: new Date().toISOString(),
        });

      // ── Protected routes (JWT authorizer applied at API GW level) ──────
      case "GET /v1/me":
        return handleGetMe(event, context);

      // ── Fallthrough ────────────────────────────────────────────────────
      default:
        return json(404, {
          code: "NOT_FOUND",
          message: "Route not found",
          requestId: context.awsRequestId,
        });
    }
  } catch (err: unknown) {
    console.error({ requestId: context.awsRequestId, error: String(err) });
    return json(500, {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
      requestId: context.awsRequestId,
    });
  }
};
