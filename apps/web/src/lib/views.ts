/**
 * Pure presentation logic, kept out of React components so it can be unit tested.
 *
 * NOTHING here grants access. The role passed in comes from GET /v1/me (the
 * server's answer) and only selects which screen to draw. Every action a screen
 * offers is re-authorized by the backend; a user who tampers with this state
 * simply gets 403/404 responses.
 */

import type { AssignmentView, ClientAction, OrgRole, SessionView, TestRunView } from "@onboardos/contracts";
import { REQUEST_TIMEOUT_MAX_MS, REQUEST_TIMEOUT_MIN_MS } from "@onboardos/contracts";
import { ApiError } from "./api.js";

export type RoleView = "manager" | "employee" | "identity";

/** Which screen to draw for a server-reported role. Admins keep the identity screen. */
export function viewForRole(role: OrgRole): RoleView {
  switch (role) {
    case "manager": return "manager";
    case "employee": return "employee";
    case "org_admin": return "identity";
  }
}

export type Tab = "ticket" | "runbook" | "diagnostics";

/**
 * The action to record when the user opens a tab, or null if they have already
 * opened it (so a refresh or a second click does not add duplicate evidence).
 * Ids come from the server-supplied scenario, never from literals.
 */
export function actionForTab(session: SessionView, tab: Tab): ClientAction | null {
  if (session.viewed[tab]) return null;
  switch (tab) {
    case "ticket": return { type: "OPEN_TICKET", ticketId: session.scenario.ticket.id };
    case "runbook": return { type: "OPEN_RUNBOOK", runbookId: session.scenario.runbook.id };
    case "diagnostics": return { type: "OPEN_DIAGNOSTICS", diagnosticsId: session.scenario.diagnostics.id };
  }
}

/** Has this employee already been assigned the scenario (used only to disable a button). */
export function hasAssignment(assignments: readonly AssignmentView[], employeeSub: string): boolean {
  return assignments.some((a) => a.employee?.userSub === employeeSub);
}

/**
 * Add an assignment the SERVER just returned to a displayed list, replacing any
 * entry with the same id, newest first. (The assignment lists are read from an
 * eventually-consistent index, so a fresh create may not appear in an immediate
 * re-read; merging the server's own response avoids a confusing gap.)
 */
export function mergeAssignment(list: readonly AssignmentView[], incoming: AssignmentView): AssignmentView[] {
  return [incoming, ...list.filter((a) => a.assignmentId !== incoming.assignmentId)].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

/** A user-facing message for a failed call. Never shows raw server internals. */
export function describeApiError(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Please try again.";
  switch (err.status) {
    case 0: return "Could not reach the server. Check your connection and try again.";
    case 401: return "Your session has expired. Please sign in again.";
    case 403: return "You do not have permission to do that.";
    case 404: return "That item was not found, or you do not have access to it.";
    case 409:
      if (err.code === "RUN_IN_PROGRESS") return "A test run is already in progress. Wait for it to finish.";
      return err.code === "VERSION_CONFLICT"
        ? "This session changed since you loaded it. It has been reloaded; please try again."
        : "That could not be completed because something changed. Please refresh.";
    case 422: return err.message || "That action is not allowed right now.";
    case 429:
      if (err.code === "RUN_LIMIT_REACHED") return "This session has reached its maximum number of test runs.";
      if (err.code === "REVISION_LIMIT_REACHED") return "This session has reached its maximum number of saved revisions.";
      return "This session has reached its action limit.";
    default: return "The server could not complete the request. Please try again.";
  }
}

// -- configuration editing (UX only; the server re-validates everything) ---------

export type TimeoutInput =
  | { ok: true; value: number }
  | { ok: false; message: string };

/**
 * Immediate feedback for the timeout field. This is a convenience, NOT a control:
 * the API validates the same bounds and rejects anything else regardless of what
 * this function says.
 */
export function parseTimeoutInput(raw: string): TimeoutInput {
  const text = raw.trim();
  if (!/^-?\d+$/.test(text)) return { ok: false, message: "Enter a whole number of milliseconds." };
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < REQUEST_TIMEOUT_MIN_MS || value > REQUEST_TIMEOUT_MAX_MS) {
    return { ok: false, message: `Enter a value between ${REQUEST_TIMEOUT_MIN_MS} and ${REQUEST_TIMEOUT_MAX_MS} ms.` };
  }
  return { ok: true, value };
}

/** First 12 hex characters of a `sha256:` hash, for display. */
export function shortHash(hash: string): string {
  return hash.replace(/^sha256:/, "").slice(0, 12);
}

/** Label and style for a run's state, accounting for evidence that is no longer current. */
export function runBadge(run: Pick<TestRunView, "status" | "stale">): { label: string; tone: "ok" | "bad" | "warn" | "neutral" } {
  const base = {
    PENDING: { label: "Running", tone: "warn" },
    RUNNING: { label: "Running", tone: "warn" },
    PASSED: { label: "Passed", tone: "ok" },
    FAILED: { label: "Failed", tone: "bad" },
    ERROR: { label: "Error", tone: "bad" },
  } as const;
  return base[run.status];
}

/** Can the user start a run right now? (The server is still the authority.) */
export function canRunTests(session: Pick<SessionView, "phase" | "activeTestRunId">, busy: boolean): boolean {
  return !busy && session.phase === "INVESTIGATING" && session.activeTestRunId === null;
}
