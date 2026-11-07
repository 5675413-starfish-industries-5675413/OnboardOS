/**
 * OnboardOS API Lambda — HTTP routing handler.
 *
 * Export: httpHandler  → wired to API Gateway HTTP API GET /health
 *
 * The smoke-test handler lives in smokeTest.ts.
 * It is NOT wired to any API Gateway event source.
 */

import type { APIGatewayProxyEventV2, Context } from "aws-lambda";

// ---------------------------------------------------------------------------
// Response type (always the structured object form, never the plain string form)
// ---------------------------------------------------------------------------

interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

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
    const routeKey = event.routeKey ?? `${event.requestContext?.http?.method} ${event.requestContext?.http?.path}`;

    switch (routeKey) {
      case "GET /health":
        return json(200, {
          status: "ok",
          service: "onboardos-api",
          timestamp: new Date().toISOString(),
        });

      default:
        return json(404, {
          code: "NOT_FOUND",
          message: "Route not found",
          requestId: context.awsRequestId,
        });
    }
  } catch (err: unknown) {
    // Never leak stack traces or internal details to the HTTP response.
    console.error({ requestId: context.awsRequestId, error: String(err) });
    return json(500, {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
      requestId: context.awsRequestId,
    });
  }
};
