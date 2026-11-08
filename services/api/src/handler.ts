/**
 * OnboardOS API Lambda -- HTTP routing handler.
 *
 * Public routes (no JWT authorizer):
 *   GET  /health
 *
 * Protected routes (API Gateway JWT authorizer required; the Lambda then
 * authorizes against DynamoDB membership -- see authz.ts):
 *   GET  /v1/me
 *   GET  /v1/orgs/{orgId}/assignable-employees
 *   GET  /v1/orgs/{orgId}/assignments
 *   POST /v1/orgs/{orgId}/assignments
 *   POST /v1/assignments/{assignmentId}/start
 *   GET  /v1/sessions/{sessionId}
 *   POST /v1/sessions/{sessionId}/actions
 *   PUT  /v1/sessions/{sessionId}/config
 *   POST /v1/sessions/{sessionId}/test-runs
 *   GET  /v1/sessions/{sessionId}/test-runs/{runId}
 *   POST /v1/sessions/{sessionId}/submissions
 *   GET  /v1/reviews/{submissionId}
 *   POST /v1/reviews/{submissionId}/decision
 *   GET  /v1/sessions/{sessionId}/messages
 *   POST /v1/sessions/{sessionId}/messages
 *
 * Route keys are API Gateway's templated keys, matched exactly. Anything else
 * is a 404. The smoke-test handler lives in smokeTest.ts and is NOT wired to
 * any API Gateway event source.
 */

import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { defaultDeps, type ApiDeps } from "./deps.js";
import { errorResult, HttpError, json, type HttpResult } from "./http.js";
import {
  handleCreateAssignment,
  handleListAssignableEmployees,
  handleListAssignments,
} from "./routes/assignments.js";
import { handleGetMe } from "./routes/me.js";
import {
  handleGetSession,
  handleSessionAction,
  handleStartAssignment,
} from "./routes/sessions.js";
import { handleGetTestRun, handleRunTests, handleSaveConfig } from "./routes/testRuns.js";
import { handleSubmitReport } from "./routes/submissions.js";
import { handleDecideReview, handleGetReview } from "./routes/reviews.js";
import { handleListMessages, handleSendMessage } from "./routes/coworker.js";
import {
  handleGetCoachingStudio,
  handleGetCoachingVersion,
  handleListCoachingScenarios,
  handlePublishCoaching,
  handleSaveCoachingDraft,
  handleValidateCoaching,
} from "./routes/coaching.js";

/**
 * Route + dispatch with injectable dependencies. `getDeps` is lazy so that
 * /health keeps working even if table configuration is wrong.
 */
export const handleRequest = async (
  event: APIGatewayProxyEventV2,
  context: Context,
  getDeps: () => ApiDeps,
): Promise<HttpResult> => {
  try {
    const routeKey =
      event.routeKey ??
      `${event.requestContext?.http?.method} ${event.requestContext?.http?.path}`;

    switch (routeKey) {
      // -- Public --------------------------------------------------------------
      case "GET /health":
        return json(200, {
          status: "ok",
          service: "onboardos-api",
          timestamp: new Date().toISOString(),
        });

      // -- Phase 2A ------------------------------------------------------------
      case "GET /v1/me":
        return await handleGetMe(event, context);

      // -- Phase 2B: assignment ------------------------------------------------
      case "GET /v1/orgs/{orgId}/assignable-employees":
        return await handleListAssignableEmployees(event, getDeps());
      case "GET /v1/orgs/{orgId}/assignments":
        return await handleListAssignments(event, getDeps());
      case "POST /v1/orgs/{orgId}/assignments":
        return await handleCreateAssignment(event, getDeps());

      // -- Phase 2B: workplace session ------------------------------------------
      case "POST /v1/assignments/{assignmentId}/start":
        return await handleStartAssignment(event, getDeps());
      case "GET /v1/sessions/{sessionId}":
        return await handleGetSession(event, getDeps());
      case "POST /v1/sessions/{sessionId}/actions":
        return await handleSessionAction(event, getDeps());

      // -- Phase 2C: config revisions and test runs -----------------------------
      case "PUT /v1/sessions/{sessionId}/config":
        return await handleSaveConfig(event, getDeps());
      case "POST /v1/sessions/{sessionId}/test-runs":
        return await handleRunTests(event, getDeps());
      case "GET /v1/sessions/{sessionId}/test-runs/{runId}":
        return await handleGetTestRun(event, getDeps());

      // -- Phase 2D: frozen submission and manager review -----------------------
      case "POST /v1/sessions/{sessionId}/submissions":
        return await handleSubmitReport(event, getDeps());
      case "GET /v1/reviews/{submissionId}":
        return await handleGetReview(event, getDeps());
      case "POST /v1/reviews/{submissionId}/decision":
        return await handleDecideReview(event, getDeps());

      // -- Phase 4: AI coworker -------------------------------------------------
      case "GET /v1/sessions/{sessionId}/messages":
        return await handleListMessages(event, getDeps());
      case "POST /v1/sessions/{sessionId}/messages":
        return await handleSendMessage(event, getDeps());

      // -- Milestone M1: manager coaching studio ------------------------------------
      case "GET /v1/orgs/{orgId}/scenarios":
        return await handleListCoachingScenarios(event, getDeps());
      case "GET /v1/orgs/{orgId}/scenarios/{scenarioId}/coaching":
        return await handleGetCoachingStudio(event, getDeps());
      case "PUT /v1/orgs/{orgId}/scenarios/{scenarioId}/coaching/draft":
        return await handleSaveCoachingDraft(event, getDeps());
      case "POST /v1/orgs/{orgId}/scenarios/{scenarioId}/coaching/validate":
        return await handleValidateCoaching(event, getDeps());
      case "POST /v1/orgs/{orgId}/scenarios/{scenarioId}/coaching/publish":
        return await handlePublishCoaching(event, getDeps());
      case "GET /v1/orgs/{orgId}/scenarios/{scenarioId}/coaching/versions/{profileVersion}":
        return await handleGetCoachingVersion(event, getDeps());

      default:
        return json(404, {
          code: "NOT_FOUND",
          message: "Route not found",
          requestId: context.awsRequestId,
        });
    }
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      return errorResult(err, context.awsRequestId);
    }
    // Never leak internals to the client; the detail stays in the logs.
    console.error({ requestId: context.awsRequestId, error: String(err) });
    return json(500, {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
      requestId: context.awsRequestId,
    });
  }
};

export const httpHandler = (event: APIGatewayProxyEventV2, context: Context): Promise<HttpResult> =>
  handleRequest(event, context, defaultDeps);
