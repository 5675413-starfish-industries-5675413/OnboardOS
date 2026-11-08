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
  ClientAction,
  CreateAssignmentResponse,
  ListAssignableEmployeesResponse,
  MeResponse,
  SessionView,
  StartSessionResponse,
} from "@onboardos/contracts";
import {
  CreateAssignmentResponseSchema,
  GetSessionResponseSchema,
  ListAssignableEmployeesResponseSchema,
  ListAssignmentsResponseSchema,
  MeResponseSchema,
  SessionActionResponseSchema,
  StartSessionResponseSchema,
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
  method: "GET" | "POST",
  path: string,
  schema: { parse: (v: unknown) => T },
  body?: unknown,
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
