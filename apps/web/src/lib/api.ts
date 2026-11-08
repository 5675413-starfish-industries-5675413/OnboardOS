/**
 * API client for the OnboardOS backend.
 *
 * Every request attaches the Cognito ACCESS token as a Bearer token, read from
 * sessionStorage via getSession(). This module never reads or transmits AWS
 * credentials, client secrets, or passwords.
 *
 * What the client does NOT do: it never sends a role, an organization the user
 * "belongs" to, an owner, or any status/result. Identity, role, ownership and
 * scope are derived by the server from the verified token and DynamoDB
 * membership. Request bodies carry only the fields the shared contracts allow,
 * and every response is validated against the shared contract before use.
 */

import type {
  AssignmentView,
  CoachingDraftContent,
  CoachingStudioResponse,
  CoachingVersionDetail,
  ListCoachingScenariosResponse,
  PublishCoachingResponse,
  SaveCoachingDraftResponse,
  ValidateCoachingResponse,
  ClientAction,
  CreateAssignmentResponse,
  ListAssignableEmployeesResponse,
  IncidentConfig,
  IncidentReport,
  ListCoworkerMessagesResponse,
  PostCoworkerMessageResponse,
  MeResponse,
  ReviewBundle,
  ReviewDecision,
  SessionView,
  StartSessionResponse,
  SubmitReportResponse,
  TestRunResponse,
} from "@onboardos/contracts";
import {
  CoachingStudioResponseSchema,
  CoachingVersionDetailSchema,
  ListCoachingScenariosResponseSchema,
  PublishCoachingResponseSchema,
  SaveCoachingDraftResponseSchema,
  ValidateCoachingResponseSchema,
  CreateAssignmentResponseSchema,
  GetSessionResponseSchema,
  ListAssignableEmployeesResponseSchema,
  ListAssignmentsResponseSchema,
  ListCoworkerMessagesResponseSchema,
  MeResponseSchema,
  PostCoworkerMessageResponseSchema,
  ReviewBundleResponseSchema,
  SaveConfigResponseSchema,
  SessionActionResponseSchema,
  StartSessionResponseSchema,
  SubmitReportResponseSchema,
  TestRunResponseSchema,
} from "@onboardos/contracts";
import { config } from "./config.js";
import { getSession, clearSession } from "./auth.js";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  schema: { parse: (v: unknown) => T },
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const session = getSession();
  if (!session) {
    throw new ApiError(401, "NO_SESSION", "Not signed in");
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    // The API Gateway JWT authorizer reads "Authorization: Bearer <token>".
    Authorization: `Bearer ${session.accessToken}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (extraHeaders) Object.assign(headers, extraHeaders);

  let response: Response;
  try {
    response = await fetch(`${config.apiBaseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    // fetch rejects on network failure and on CORS rejection.
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the OnboardOS API.");
  }

  if (response.status === 401) {
    // Expired/invalid session: drop it so the app returns to the sign-in page.
    clearSession();
    throw new ApiError(401, "UNAUTHORIZED", "Your session has expired. Please sign in again.");
  }

  if (!response.ok) {
    let code = "UNKNOWN";
    let message = `Request failed (HTTP ${response.status}).`;
    try {
      const err = (await response.json()) as { code?: unknown; message?: unknown };
      if (typeof err.code === "string") code = err.code;
      if (typeof err.message === "string") message = err.message;
    } catch {
      // non-JSON error body: keep defaults
    }
    throw new ApiError(response.status, code, message);
  }

  // Validate against the shared contract before anything uses the data.
  return schema.parse(await response.json());
}

/** Path segments come from our own state, but are encoded anyway so an id can never alter the path. */
const seg = (v: string): string => encodeURIComponent(v);

// -- identity -----------------------------------------------------------------

/** GET /v1/me -- the authenticated user's identity and ACTIVE memberships. */
export function getMe(): Promise<MeResponse> {
  return request("GET", "/v1/me", MeResponseSchema);
}

// -- manager ------------------------------------------------------------------

/** Employees the caller may assign work to (scoped by the server). */
export function listAssignableEmployees(orgId: string): Promise<ListAssignableEmployeesResponse> {
  return request("GET", `/v1/orgs/${seg(orgId)}/assignable-employees`, ListAssignableEmployeesResponseSchema);
}

/** The scenario this slice can assign. The server resolves the published version. */
export const INC_104 = "inc-104";

/**
 * Assign INC-104 to an employee. The body is exactly { scenarioId, employeeSub }:
 * the organization is in the URL, and the assigning manager is the token's subject.
 */
export function createAssignment(orgId: string, employeeSub: string): Promise<CreateAssignmentResponse> {
  return request("POST", `/v1/orgs/${seg(orgId)}/assignments`, CreateAssignmentResponseSchema, {
    scenarioId: INC_104,
    employeeSub,
  });
}

/** Employees: their own assignments. Managers/admins: assignments they created. */
export async function listAssignments(orgId: string): Promise<AssignmentView[]> {
  return (await request("GET", `/v1/orgs/${seg(orgId)}/assignments`, ListAssignmentsResponseSchema)).assignments;
}

// -- employee -----------------------------------------------------------------

/** Start (or resume) the investigation. Idempotent on the server. */
export function startAssignment(assignmentId: string): Promise<StartSessionResponse> {
  return request("POST", `/v1/assignments/${seg(assignmentId)}/start`, StartSessionResponseSchema);
}

/** Authoritative session state. Safe to call after a refresh. */
export async function fetchSession(sessionId: string): Promise<SessionView> {
  return (await request("GET", `/v1/sessions/${seg(sessionId)}`, GetSessionResponseSchema)).session;
}

/**
 * Record one validated semantic action. `expectedStateVersion` is the version
 * the user last saw; the server rejects (409) if the session has moved on.
 */
export async function postSessionAction(
  sessionId: string,
  expectedStateVersion: number,
  action: ClientAction,
): Promise<SessionView> {
  return (
    await request("POST", `/v1/sessions/${seg(sessionId)}/actions`, SessionActionResponseSchema, {
      expectedStateVersion,
      action,
    })
  ).session;
}

// -- configuration and tests ----------------------------------------------------

/**
 * Save the configuration as a new immutable revision. The body is exactly
 * { expectedStateVersion, config }: the server assigns the revision number,
 * computes the hash, and re-validates the value (range and type).
 */
export async function saveConfig(
  sessionId: string,
  expectedStateVersion: number,
  config: IncidentConfig,
): Promise<SessionView> {
  return (
    await request("PUT", `/v1/sessions/${seg(sessionId)}/config`, SaveConfigResponseSchema, {
      expectedStateVersion,
      config,
    })
  ).session;
}

/**
 * Run the fixed suite against the CURRENT saved revision in the AWS Lambda
 * runner. The body carries only the version the user last saw: the client never
 * sends a revision, a hash, a suite, an expectation or a result.
 */
export function requestTestRun(sessionId: string, expectedStateVersion: number): Promise<TestRunResponse> {
  return request("POST", `/v1/sessions/${seg(sessionId)}/test-runs`, TestRunResponseSchema, {
    expectedStateVersion,
  });
}

/** Poll one run (the server also closes a run that never completed). */
export function fetchTestRun(sessionId: string, testRunId: string): Promise<TestRunResponse> {
  return request("GET", `/v1/sessions/${seg(sessionId)}/test-runs/${seg(testRunId)}`, TestRunResponseSchema);
}

// -- submission and review --------------------------------------------------------

/**
 * Submit the incident report. The body is the report plus the employee's ASSERTION of which
 * evidence they are looking at (run id, revision, hash) -- the server derives the real evidence
 * itself and rejects any difference. `idempotencyKey` must be reused for a retry of the SAME
 * content, so a lost response can never create a second submission.
 */
export function submitReport(
  sessionId: string,
  input: { expectedStateVersion: number; testRunId: string; configRevision: number; configHash: string; report: IncidentReport },
  idempotencyKey: string,
): Promise<SubmitReportResponse> {
  return request(
    "POST",
    `/v1/sessions/${seg(sessionId)}/submissions`,
    SubmitReportResponseSchema,
    input,
    { "Idempotency-Key": idempotencyKey },
  );
}

/** Manager/admin: the read-only evidence bundle for one frozen submission. */
export async function fetchReview(submissionId: string): Promise<ReviewBundle> {
  return (await request("GET", `/v1/reviews/${seg(submissionId)}`, ReviewBundleResponseSchema)).review;
}

/** Manager/admin: record the (final) decision. Feedback is sent only when there is some. */
export async function postReviewDecision(
  submissionId: string,
  decision: ReviewDecision,
  feedback: string,
): Promise<ReviewBundle> {
  const text = feedback.trim();
  return (
    await request("POST", `/v1/reviews/${seg(submissionId)}/decision`, ReviewBundleResponseSchema, {
      decision,
      ...(text ? { feedback: text } : {}),
    })
  ).review;
}

// -- AI coworker ---------------------------------------------------------------

/** The persisted conversation for a session, plus whether a new question can be asked right now. */
export function fetchCoworker(sessionId: string): Promise<ListCoworkerMessagesResponse> {
  return request("GET", `/v1/sessions/${seg(sessionId)}/messages`, ListCoworkerMessagesResponseSchema);
}

/**
 * Ask the AI coworker one question. The body is exactly { message }: the model, the prompt, the role
 * and everything else are decided by the server. Reuse `idempotencyKey` only to RETRY the same text
 * after a lost response; a new question (or a deliberate retry after an error) needs a new key.
 */
export function sendCoworkerMessage(
  sessionId: string,
  message: string,
  idempotencyKey: string,
): Promise<PostCoworkerMessageResponse> {
  return request(
    "POST",
    `/v1/sessions/${seg(sessionId)}/messages`,
    PostCoworkerMessageResponseSchema,
    { message },
    { "Idempotency-Key": idempotencyKey },
  );
}


// -- manager coaching studio (milestone M1) -----------------------------------------------------------------
// The organization comes from the URL and is authorized by the server against membership. Bodies carry only the
// editable content and the revisions the editor was looking at: never an organization, role, owner, version number
// to allocate, status or hash.

const coachingPath = (orgId: string, scenarioId: string): string => `/v1/orgs/${seg(orgId)}/scenarios/${seg(scenarioId)}/coaching`;

/** GET /v1/orgs/{orgId}/scenarios: the supported (executable) scenarios and this organization's coaching status. */
export function listCoachingScenarios(orgId: string): Promise<ListCoachingScenariosResponse> {
  return request("GET", `/v1/orgs/${seg(orgId)}/scenarios`, ListCoachingScenariosResponseSchema);
}

export function getCoachingStudio(orgId: string, scenarioId: string): Promise<CoachingStudioResponse> {
  return request("GET", coachingPath(orgId, scenarioId), CoachingStudioResponseSchema);
}

/** Save the draft. `expectedRevision` is 0 for the first save, otherwise the revision the edit was based on. */
export function saveCoachingDraft(orgId: string, scenarioId: string, expectedRevision: number, content: CoachingDraftContent): Promise<SaveCoachingDraftResponse> {
  return request("PUT", `${coachingPath(orgId, scenarioId)}/draft`, SaveCoachingDraftResponseSchema, { expectedRevision, content });
}

/** Validate unsaved content and describe the behaviour it selects. Persists nothing; calls no model. */
export function validateCoaching(orgId: string, scenarioId: string, content: CoachingDraftContent): Promise<ValidateCoachingResponse> {
  return request("POST", `${coachingPath(orgId, scenarioId)}/validate`, ValidateCoachingResponseSchema, { content });
}

export function publishCoaching(orgId: string, scenarioId: string, draftRevision: number, expectedCurrentVersion: number): Promise<PublishCoachingResponse> {
  return request("POST", `${coachingPath(orgId, scenarioId)}/publish`, PublishCoachingResponseSchema, { draftRevision, expectedCurrentVersion });
}

/** One published version, read-only. */
export function getCoachingVersion(orgId: string, scenarioId: string, profileVersion: number): Promise<CoachingVersionDetail> {
  return request("GET", `${coachingPath(orgId, scenarioId)}/versions/${profileVersion}`, CoachingVersionDetailSchema);
}
