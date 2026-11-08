/**
 * Employee-facing routes:
 *   POST /v1/assignments/{assignmentId}/start   start or resume (idempotent)
 *   GET  /v1/sessions/{sessionId}               authoritative state
 *   POST /v1/sessions/{sessionId}/actions       one validated semantic action
 *
 * Ownership is enforced on every request: the verified subject must be the
 * assignment's / session's employee AND hold an ACTIVE employee membership in
 * its organization. Anything else is an opaque 404, so another user's ids reveal
 * nothing. Manager preview of a session is intentionally NOT part of this slice.
 */

import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  GetSessionResponseSchema,
  SessionActionRequestSchema,
  SessionActionResponseSchema,
  StartSessionResponseSchema,
} from "@onboardos/contracts";
import {
  reduceScenario,
  startSession,
  type Rejection,
  type WorkplaceAction,
  type WorkplaceState,
} from "@onboardos/scenario-engine";
import { getPublishedScenario } from "@onboardos/scenario-fixtures";
import { authenticate, loadActiveMembership, NOT_FOUND } from "../authz.js";
import type { ApiDeps } from "../deps.js";
import { HttpError, json, parseBody, pathParam, type HttpResult } from "../http.js";
import { ASSIGNMENT_ID_PATTERN, SESSION_ID_PATTERN, sessionIdFor } from "../ids.js";
import {
  eventItem,
  parseAssignment,
  parseSessionState,
  sessionItem,
  toSessionView,
  type AssignmentRecord,
} from "../records.js";
import {
  getAssignmentItem,
  getSessionItem,
  isTransactionCanceled,
  transactApplyAction,
  transactStartSession,
} from "../repo.js";

const INTERNAL = (what: string): Error => new Error(what);

/** The published scenario a stored record is frozen to. Missing => server fault, never a guess. */
function scenarioFor(scenarioId: string, version: number) {
  const scenario = getPublishedScenario(scenarioId, version);
  if (!scenario) throw INTERNAL(`published scenario ${scenarioId}@${version} is not available`);
  return scenario;
}

/** Load a session the caller owns and may still use, or throw an opaque 404. */
async function loadOwnedSession(
  deps: ApiDeps,
  event: APIGatewayProxyEventV2,
): Promise<{ state: WorkplaceState; sub: string }> {
  const { userSub: sub } = authenticate(event);
  const sessionId = pathParam(event, "sessionId") ?? "";
  if (!SESSION_ID_PATTERN.test(sessionId)) throw NOT_FOUND();

  const item = await getSessionItem(deps.db, sessionId);
  if (!item) throw NOT_FOUND();
  const state = parseSessionState(item);
  if (!state) throw INTERNAL("stored session is malformed");

  if (state.employeeSub !== sub) throw NOT_FOUND();
  const member = await loadActiveMembership(deps, state.organizationId, sub);
  if (!member || member.role !== "employee") throw NOT_FOUND();
  return { state, sub };
}

/** Load the existing session for an assignment that is already in progress. */
async function loadExistingSession(deps: ApiDeps, assignment: AssignmentRecord): Promise<WorkplaceState> {
  const expectedId = sessionIdFor(assignment.assignmentId);
  if (assignment.sessionId !== expectedId) throw INTERNAL("assignment references an unexpected session");
  const item = await getSessionItem(deps.db, expectedId);
  const state = item ? parseSessionState(item) : null;
  if (!state || state.assignmentId !== assignment.assignmentId || state.employeeSub !== assignment.employeeSub) {
    throw INTERNAL("assignment is in progress but its session is missing or inconsistent");
  }
  return state;
}

export async function handleStartAssignment(
  event: APIGatewayProxyEventV2,
  deps: ApiDeps,
): Promise<HttpResult> {
  const { userSub: sub } = authenticate(event);
  const assignmentId = pathParam(event, "assignmentId") ?? "";
  if (!ASSIGNMENT_ID_PATTERN.test(assignmentId)) throw NOT_FOUND();

  const item = await getAssignmentItem(deps.db, assignmentId);
  if (!item) throw NOT_FOUND();
  const assignment = parseAssignment(item);
  if (!assignment) throw INTERNAL("stored assignment is malformed");

  // Only the assigned employee, and only while they remain an ACTIVE employee of that org.
  if (assignment.employeeSub !== sub) throw NOT_FOUND();
  const member = await loadActiveMembership(deps, assignment.organizationId, sub);
  if (!member || member.role !== "employee") throw NOT_FOUND();

  const scenario = scenarioFor(assignment.scenarioId, assignment.scenarioVersion);

  // Already started: this is a retry/resume. Return the existing authoritative session.
  if (assignment.status === "IN_PROGRESS") {
    const state = await loadExistingSession(deps, assignment);
    return json(200, StartSessionResponseSchema.parse({ session: toSessionView(state, scenario), created: false }));
  }
  if (assignment.status !== "ASSIGNED") {
    throw new HttpError(409, "INVALID_ASSIGNMENT_STATE", "This assignment can no longer be started");
  }

  const sessionId = sessionIdFor(assignment.assignmentId);
  const now = deps.now();
  const started = startSession(
    scenario,
    { sessionId, assignmentId, organizationId: assignment.organizationId, employeeSub: sub },
    { now, actorSub: sub },
  );
  if (!started.ok || started.events.length !== 1) throw INTERNAL("engine rejected a valid start");
  const [firstEvent] = started.events;
  if (!firstEvent) throw INTERNAL("engine produced no start event");

  try {
    await transactStartSession(deps.db, {
      sessionItem: sessionItem(started.nextState),
      firstEventItem: eventItem(started.nextState, firstEvent),
      assignmentId,
      sessionId,
      employeeSub: sub,
      now,
    });
  } catch (err) {
    if (!isTransactionCanceled(err)) throw err;
    // A condition failed: most likely a concurrent start of this same assignment won the race.
    const latest = parseAssignment(await getAssignmentItem(deps.db, assignmentId));
    if (latest && latest.status === "IN_PROGRESS" && latest.employeeSub === sub) {
      const state = await loadExistingSession(deps, latest);
      return json(200, StartSessionResponseSchema.parse({ session: toSessionView(state, scenario), created: false }));
    }
    throw new HttpError(409, "CONFLICT", "The assignment could not be started");
  }

  return json(201, StartSessionResponseSchema.parse({ session: toSessionView(started.nextState, scenario), created: true }));
}

export async function handleGetSession(
  event: APIGatewayProxyEventV2,
  deps: ApiDeps,
): Promise<HttpResult> {
  const { state } = await loadOwnedSession(deps, event);
  const scenario = scenarioFor(state.scenarioId, state.scenarioVersion);
  return json(200, GetSessionResponseSchema.parse({ session: toSessionView(state, scenario) }));
}

const REJECTION_STATUS: Record<Rejection["code"], { status: number; code: string }> = {
  VERSION_CONFLICT: { status: 409, code: "VERSION_CONFLICT" },
  INVALID_TRANSITION: { status: 422, code: "INVALID_TRANSITION" },
  UNKNOWN_OBJECT: { status: 422, code: "UNKNOWN_OBJECT" },
  LIMIT_REACHED: { status: 429, code: "LIMIT_REACHED" },
  // The API authorizes ownership first, so these indicate a bug or tampering: do not explain.
  NOT_OWNER: { status: 404, code: "NOT_FOUND" },
  SCENARIO_MISMATCH: { status: 500, code: "INTERNAL_ERROR" },
};

export async function handleSessionAction(
  event: APIGatewayProxyEventV2,
  deps: ApiDeps,
): Promise<HttpResult> {
  const { state, sub } = await loadOwnedSession(deps, event);
  const body = parseBody(event, SessionActionRequestSchema);
  const scenario = scenarioFor(state.scenarioId, state.scenarioVersion);

  // Only the validated semantic action is used; the expected version is the client's
  // claim about what it saw, checked against the authoritative state by the engine.
  const action: WorkplaceAction = { ...body.action, expectedVersion: body.expectedStateVersion };
  const result = reduceScenario(scenario, state, action, { now: deps.now(), actorSub: sub });

  if (!result.ok) {
    const mapped = REJECTION_STATUS[result.error.code];
    if (mapped.status >= 500) throw INTERNAL(`engine rejection ${result.error.code}`);
    throw new HttpError(mapped.status, mapped.code, result.error.message);
  }

  try {
    await transactApplyAction(deps.db, {
      nextSessionItem: sessionItem(result.nextState),
      eventItems: result.events.map((e) => eventItem(result.nextState, e)),
      expectedVersion: state.stateVersion,
      employeeSub: sub,
    });
  } catch (err) {
    if (!isTransactionCanceled(err)) throw err;
    // Someone else changed the session between our read and our write.
    const latest = parseSessionState(await getSessionItem(deps.db, state.sessionId));
    if (latest && latest.stateVersion !== state.stateVersion) {
      throw new HttpError(409, "VERSION_CONFLICT", "Session state has changed; reload and retry");
    }
    throw err;
  }

  return json(200, SessionActionResponseSchema.parse({ session: toSessionView(result.nextState, scenario) }));
}
