/**
 * Pure presentation logic, kept out of React components so it can be unit tested.
 *
 * NOTHING here grants access. The role passed in comes from GET /v1/me (the
 * server's answer) and only selects which screen to draw. Every action a screen
 * offers is re-authorized by the backend; a user who tampers with this state
 * simply gets 403/404 responses.
 */

import type { AssignmentView, ClientAction, OrgRole, SessionView } from "@onboardos/contracts";
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
    case 409: return err.code === "VERSION_CONFLICT"
      ? "This session changed since you loaded it. It has been reloaded; please try again."
      : "That could not be completed because something changed. Please refresh.";
    case 422: return err.message || "That action is not allowed right now.";
    case 429: return "This session has reached its action limit.";
    default: return "The server could not complete the request. Please try again.";
  }
}
