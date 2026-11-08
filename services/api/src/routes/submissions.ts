/**
 * POST /v1/sessions/{sessionId}/submissions -- freeze an incident report and its evidence.
 *
 * The submission is built entirely from records the SERVER already holds (the
 * session, the immutable config snapshot, the terminal test run, the published
 * scenario). The request supplies the report text and an ASSERTION of which
 * evidence the employee believes they are submitting; the server derives the real
 * current evidence itself and rejects any difference. Nothing client-supplied is
 * ever stored as authority.
 *
 * One transaction commits: the session lock (INVESTIGATING -> SUBMITTED, under the
 * version + owner condition), the immutable submission (create-if-absent), the
 * idempotency ledger entry (create-if-absent), the assignment transition
 * IN_PROGRESS -> AWAITING_REVIEW (conditional on this very session) and the event.
 * Without AI evaluation the assignment goes straight to AWAITING_REVIEW with
 * evaluation = NOT_CONFIGURED; a separate second write would be non-atomic.
 */

import { createHash } from "node:crypto";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  SubmitReportRequestSchema,
  SubmitReportResponseSchema,
  type IncidentReport,
} from "@onboardos/contracts";
import { isCurrentRun, reduceScenario, type WorkplaceState } from "@onboardos/scenario-engine";
import type { ApiDeps } from "../deps.js";
import { loadHistory } from "../history.js";
import { HttpError, json, parseBody, type HttpResult } from "../http.js";
import { IDEMPOTENCY_KEY_PATTERN, submissionIdFor } from "../ids.js";
import {
  buildLedgerRecord,
  buildSubmissionRecord,
  eventItem,
  parseAssignment,
  parseLedger,
  parseSessionState,
  parseSubmission,
  sessionItem,
  toSubmissionView,
  toSessionView,
  type SessionHistory,
  type TestRunRecord,
} from "../records.js";
import {
  CREATE_ONLY,
  getAssignmentItem,
  getSessionItem,
  getSubmissionItem,
  getSubmitLedgerItem,
  isTransactionCanceled,
  transactApplyAction,
} from "../repo.js";
import { rejectionToError } from "./rejections.js";
import { INTERNAL, loadOwnedSession, scenarioFor } from "./sessions.js";

/** Four report fields at up to 1500 characters each, in JSON, with room for multi-byte text. */
export const MAX_SUBMISSION_BODY_BYTES = 16_384;

/** The header name API Gateway delivers (HTTP APIs lower-case request header names). */
export function idempotencyKey(event: APIGatewayProxyEventV2): string {
  const raw = event.headers?.["idempotency-key"] ?? event.headers?.["Idempotency-Key"];
  if (typeof raw !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    throw new HttpError(400, "INVALID_REQUEST", "An Idempotency-Key header of 8-64 letters, digits, '-' or '_' is required");
  }
  return raw;
}

/** Stable hash of what the employee is submitting (NOT the version, which a retry may legitimately refresh). */
function requestHash(body: { testRunId: string; configRevision: number; configHash: string; report: IncidentReport }): string {
  const r = body.report;
  const canonical = JSON.stringify({
    testRunId: body.testRunId,
    configRevision: body.configRevision,
    configHash: body.configHash,
    report: {
      rootCause: r.rootCause,
      correctiveAction: r.correctiveAction,
      verification: r.verification,
      remainingRisks: r.remainingRisks,
    },
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The evidence a submission may be bound to: the NEWEST run whose revision, hash and suite
 * version equal the session's current ones. Pure over server records.
 *
 *  - none current           -> EVIDENCE_NOT_CURRENT (stale or never run)
 *  - newest current PENDING -> RUN_IN_PROGRESS
 *  - newest current ERROR   -> EVIDENCE_NOT_COMPLETED (no results were produced)
 *  - PASSED or FAILED       -> usable. A FAILED run is honest evidence for review, not a resolution.
 */
export function selectSubmissionEvidence(
  state: WorkplaceState,
  suiteVersion: number,
  history: SessionHistory,
): TestRunRecord {
  const run = history.runs.find((r) => isCurrentRun(r, state, suiteVersion));
  if (!run) {
    throw new HttpError(422, "EVIDENCE_NOT_CURRENT", "Run the tests on your current saved configuration before submitting");
  }
  if (run.status === "PENDING") throw new HttpError(409, "RUN_IN_PROGRESS", "Wait for the running test to finish before submitting");
  if (run.status === "ERROR") {
    throw new HttpError(422, "EVIDENCE_NOT_COMPLETED", "The latest test run for this configuration produced no results; run the tests again");
  }
  return run;
}

async function reloadState(deps: ApiDeps, sessionId: string): Promise<WorkplaceState> {
  const state = parseSessionState(await getSessionItem(deps.db, sessionId));
  if (!state) throw INTERNAL("stored session is missing or malformed");
  return state;
}

/** Return a previously stored submission for a repeated request (same key, same content). */
async function replay(deps: ApiDeps, state: WorkplaceState, submissionId: string): Promise<HttpResult> {
  const scenario = scenarioFor(state.scenarioId, state.scenarioVersion);
  const fresh = await reloadState(deps, state.sessionId);
  const history = await loadHistory(deps.db, fresh.sessionId, fresh.assignmentId);
  const sub = history.submissions.find((s) => s.submissionId === submissionId);
  if (!sub) throw INTERNAL("idempotency ledger points at a missing submission");
  const decision = history.decisions.find((d) => d.submissionId === submissionId);
  return json(
    200,
    SubmitReportResponseSchema.parse({
      submission: toSubmissionView(sub, decision),
      session: toSessionView(fresh, scenario, history),
      created: false,
    }),
  );
}

export async function handleSubmitReport(event: APIGatewayProxyEventV2, deps: ApiDeps): Promise<HttpResult> {
  const { state, sub } = await loadOwnedSession(deps, event);
  const key = idempotencyKey(event);
  const body = parseBody(event, SubmitReportRequestSchema, MAX_SUBMISSION_BODY_BYTES);
  const hash = requestHash(body);
  const submissionId = submissionIdFor(state.assignmentId, state.attemptNumber);

  // Persistent idempotency: a repeat of an already-committed request returns the original;
  // the same key with different content is a client bug and is refused.
  const ledgerItem = await getSubmitLedgerItem(deps.db, state.sessionId, key);
  if (ledgerItem) {
    const ledger = parseLedger(ledgerItem);
    if (!ledger) throw INTERNAL("stored idempotency record is malformed");
    if (ledger.requestHash !== hash) {
      throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "That Idempotency-Key was already used for a different submission");
    }
    return replay(deps, state, ledger.submissionId);
  }

  const scenario = scenarioFor(state.scenarioId, state.scenarioVersion);
  const history = await loadHistory(deps.db, state.sessionId, state.assignmentId);

  if (state.phase === "SUBMITTED") {
    throw new HttpError(409, "ALREADY_SUBMITTED", "This attempt has already been submitted");
  }

  // The assignment must still be this employee's open attempt on THIS session.
  const assignment = parseAssignment(await getAssignmentItem(deps.db, state.assignmentId));
  if (
    !assignment ||
    assignment.employeeSub !== sub ||
    assignment.sessionId !== state.sessionId ||
    assignment.status !== "IN_PROGRESS"
  ) {
    throw new HttpError(409, "INVALID_ASSIGNMENT_STATE", "This assignment is not open for submission");
  }

  // Evidence is derived on the server; the employee's assertion must match it exactly.
  if (state.activeTestRunId !== null) {
    throw new HttpError(409, "RUN_IN_PROGRESS", "Wait for the running test to finish before submitting");
  }
  const run = selectSubmissionEvidence(state, scenario.testSuiteVersion, history);
  if (
    body.testRunId !== run.testRunId ||
    body.configRevision !== state.configRevision ||
    body.configHash !== state.configHash ||
    body.configHash !== run.configHash
  ) {
    throw new HttpError(409, "EVIDENCE_MISMATCH", "The evidence you reviewed is no longer the current evidence; reload and review it again");
  }

  const now = deps.now();
  const result = reduceScenario(
    scenario,
    state,
    { type: "SUBMIT_REPORT", submissionId, expectedVersion: body.expectedStateVersion },
    { now, actorSub: sub },
  );
  if (!result.ok) throw rejectionToError(result.error);

  const record = buildSubmissionRecord({ next: result.nextState, scenario, run, report: body.report, submissionId, now });

  try {
    await transactApplyAction(deps.db, {
      nextSessionItem: sessionItem(result.nextState),
      eventItems: result.events.map((e) => eventItem(result.nextState, e)),
      expectedVersion: state.stateVersion,
      employeeSub: sub,
      extraCorePuts: [
        { item: record as Record<string, unknown>, condition: CREATE_ONLY },
        { item: buildLedgerRecord(state.sessionId, key, hash, submissionId, now) as Record<string, unknown>, condition: CREATE_ONLY },
      ],
      extraCoreUpdates: [
        {
          key: { PK: `ASSIGN#${state.assignmentId}`, SK: "META" },
          expression: "SET #status = :awaiting, latestSubmissionId = :submissionId, updatedAt = :now",
          condition: "#status = :inProgress AND employeeSub = :employeeSub AND sessionId = :sessionId",
          names: { "#status": "status" },
          values: {
            ":awaiting": "AWAITING_REVIEW",
            ":inProgress": "IN_PROGRESS",
            ":submissionId": submissionId,
            ":employeeSub": sub,
            ":sessionId": state.sessionId,
            ":now": now,
          },
        },
      ],
    });
  } catch (err) {
    if (!isTransactionCanceled(err)) throw err;
    // Lost a race. If an identical request already committed, this is a replay: return the original.
    const raced = parseLedger(await getSubmitLedgerItem(deps.db, state.sessionId, key));
    if (raced) {
      if (raced.requestHash !== hash) {
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "That Idempotency-Key was already used for a different submission");
      }
      return replay(deps, state, raced.submissionId);
    }
    const latest = parseSessionState(await getSessionItem(deps.db, state.sessionId));
    if (latest && (latest.stateVersion !== state.stateVersion || latest.phase !== state.phase)) {
      throw new HttpError(409, "VERSION_CONFLICT", "Session state has changed; reload and retry");
    }
    // Make sure nobody has already stored a submission for this attempt under another key.
    if (parseSubmission(await getSubmissionItem(deps.db, state.assignmentId, state.attemptNumber))) {
      throw new HttpError(409, "ALREADY_SUBMITTED", "This attempt has already been submitted");
    }
    throw err;
  }

  const finalHistory = await loadHistory(deps.db, state.sessionId, state.assignmentId);
  const stored = finalHistory.submissions.find((s) => s.submissionId === submissionId);
  if (!stored) throw INTERNAL("submission was committed but cannot be read back");
  return json(
    201,
    SubmitReportResponseSchema.parse({
      submission: toSubmissionView(stored, undefined),
      session: toSessionView(result.nextState, scenario, finalHistory),
      created: true,
    }),
  );
}
