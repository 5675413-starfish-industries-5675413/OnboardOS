/**
 * Pure presentation logic, kept out of React components so it can be unit tested.
 *
 * NOTHING here grants access. The role passed in comes from GET /v1/me (the
 * server's answer) and only selects which screen to draw. Every action a screen
 * offers is re-authorized by the backend; a user who tampers with this state
 * simply gets 403/404 responses.
 */

import type {
  AssignmentStatus,
  AssignmentView,
  ClientAction,
  IncidentReport,
  OrgRole,
  ReviewDecision,
  SessionView,
  TestRunView,
} from "@onboardos/contracts";
import {
  FEEDBACK_MAX,
  FEEDBACK_MIN,
  REPORT_FIELD_MAX,
  REPORT_FIELD_MIN,
  REQUEST_TIMEOUT_MAX_MS,
  REQUEST_TIMEOUT_MIN_MS,
} from "@onboardos/contracts";
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
  // A submitted attempt is locked: reading is free, but nothing more is recorded.
  if (session.phase === "SUBMITTED" || session.viewed[tab]) return null;
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
      if (err.code === "EVIDENCE_MISMATCH") return "The test result you were looking at is no longer the current one. It has been reloaded; review it and submit again.";
      if (err.code === "ALREADY_SUBMITTED") return "This attempt has already been submitted.";
      if (err.code === "ALREADY_DECIDED") return "A decision has already been recorded for this submission. It cannot be changed.";
      if (err.code === "NOT_AWAITING_REVIEW") return "This submission is not awaiting review.";
      if (err.code === "IDEMPOTENCY_CONFLICT") return "That submission was already sent with different content. Review your report and submit again.";
      if (err.code === "ATTEMPT_LIMIT_REACHED") return "No further attempts are available for this assignment.";
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

// -- assignment status ------------------------------------------------------------

const STATUS_LABELS: Record<AssignmentStatus, string> = {
  ASSIGNED: "Assigned",
  IN_PROGRESS: "In progress",
  SUBMITTED: "Submitted",
  EVALUATING: "Evaluating",
  AWAITING_REVIEW: "Awaiting review",
  APPROVED: "Approved",
  REVISION_REQUESTED: "Revision requested",
};

export function assignmentStatusLabel(status: AssignmentStatus): string {
  return STATUS_LABELS[status];
}

export function assignmentStatusTone(status: AssignmentStatus): "ok" | "bad" | "warn" | "neutral" {
  switch (status) {
    case "APPROVED": return "ok";
    case "REVISION_REQUESTED": return "bad";
    case "IN_PROGRESS":
    case "AWAITING_REVIEW":
    case "SUBMITTED":
    case "EVALUATING": return "warn";
    case "ASSIGNED": return "neutral";
  }
}

export function toneClass(tone: "ok" | "bad" | "warn" | "neutral"): string {
  return tone === "ok" ? "pill pill-ok" : tone === "bad" ? "pill pill-bad" : tone === "warn" ? "pill pill-progress" : "pill";
}

/** The manager's review queue: submissions waiting for a decision, and those already decided. */
export function reviewQueue(assignments: readonly AssignmentView[]): { waiting: AssignmentView[]; decided: AssignmentView[] } {
  const hasSubmission = (a: AssignmentView) => a.latestSubmissionId !== null;
  return {
    waiting: assignments.filter((a) => a.status === "AWAITING_REVIEW" && hasSubmission(a)),
    decided: assignments.filter((a) => (a.status === "APPROVED" || a.status === "REVISION_REQUESTED") && hasSubmission(a)),
  };
}

// -- incident report (UX validation only; the server enforces the same limits) -----

export type ReportDraft = Record<keyof IncidentReport, string>;
export const EMPTY_REPORT: ReportDraft = { rootCause: "", correctiveAction: "", verification: "", remainingRisks: "" };

export const REPORT_FIELDS: Array<{ key: keyof IncidentReport; label: string; hint: string }> = [
  { key: "rootCause", label: "Root cause", hint: "What caused the checkout timeouts?" },
  { key: "correctiveAction", label: "Corrective action", hint: "What did you change, and why?" },
  { key: "verification", label: "Verification and test results", hint: "How do you know? Refer to the test result shown above." },
  { key: "remainingRisks", label: "Remaining risks and follow-up", hint: "What could still go wrong? Write 'none identified' if nothing." },
];

export type ReportCheck =
  | { ok: true; report: IncidentReport }
  | { ok: false; errors: Partial<Record<keyof IncidentReport, string>> };

export function validateReport(draft: ReportDraft): ReportCheck {
  const errors: Partial<Record<keyof IncidentReport, string>> = {};
  for (const { key, label } of REPORT_FIELDS) {
    const len = draft[key].trim().length;
    if (len < REPORT_FIELD_MIN) errors[key] = `${label} needs at least ${REPORT_FIELD_MIN} characters.`;
    else if (len > REPORT_FIELD_MAX) errors[key] = `${label} must be at most ${REPORT_FIELD_MAX} characters.`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    report: {
      rootCause: draft.rootCause.trim(),
      correctiveAction: draft.correctiveAction.trim(),
      verification: draft.verification.trim(),
      remainingRisks: draft.remainingRisks.trim(),
    },
  };
}

export type Readiness =
  | { ready: true; run: TestRunView }
  | { ready: false; reason: string };

/**
 * Can the employee submit right now, and on which evidence? This mirrors the server's rule so the
 * button explains itself; the server re-derives the evidence and is the only authority.
 */
export function submissionReadiness(session: Pick<SessionView, "phase" | "activeTestRunId" | "currentEvidence" | "testRuns">): Readiness {
  if (session.phase !== "INVESTIGATING") return { ready: false, reason: "This attempt is no longer open for submission." };
  if (session.activeTestRunId !== null) return { ready: false, reason: "A test run is in progress. Wait for it to finish." };
  const e = session.currentEvidence;
  if (e.status === "NONE" || e.testRunId === null) {
    return { ready: false, reason: "Run the tests on your current configuration before submitting." };
  }
  if (e.status === "ERROR") return { ready: false, reason: "The latest test run produced no results. Run the tests again." };
  const run = session.testRuns.find((r) => r.testRunId === e.testRunId);
  if (!run || !run.current || (run.status !== "PASSED" && run.status !== "FAILED")) {
    return { ready: false, reason: "Run the tests on your current configuration before submitting." };
  }
  return { ready: true, run };
}

/** What a test result means for a reader: a failed run is evidence, not a resolution. */
export function evidenceNote(status: "PASSED" | "FAILED"): string {
  return status === "PASSED"
    ? "The tests passed for this configuration."
    : "The tests FAILED for this configuration. You may submit this as honest evidence, but it does not show the incident is resolved. Say so in your report.";
}

export type DecisionCheck = { ok: true } | { ok: false; message: string };

export function validateDecision(decision: ReviewDecision | "", feedback: string): DecisionCheck {
  if (decision === "") return { ok: false, message: "Choose approve or request revision." };
  const len = feedback.trim().length;
  if (len > FEEDBACK_MAX) return { ok: false, message: `Feedback must be at most ${FEEDBACK_MAX} characters.` };
  if (decision === "REQUEST_REVISION" && len < FEEDBACK_MIN) {
    return { ok: false, message: `Write at least ${FEEDBACK_MIN} characters telling the employee what to change.` };
  }
  return { ok: true };
}
