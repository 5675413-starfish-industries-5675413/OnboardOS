/**
 * Configuration revisions and real test runs:
 *   PUT  /v1/sessions/{sessionId}/config               save an immutable, numbered revision
 *   POST /v1/sessions/{sessionId}/test-runs            run the fixed suite against the CURRENT revision
 *   GET  /v1/sessions/{sessionId}/test-runs/{runId}    poll one run
 *
 * Authority:
 *  - every route re-checks the verified subject owns the session and is an ACTIVE
 *    employee of its organization (anything else is an opaque 404);
 *  - request bodies are strict: the client sends a config and a version, never a
 *    revision number, hash, suite, expectation or result;
 *  - results are recorded only through the engine's RECORD_TEST_RESULT action under
 *    the system identity, and only from a runner response the API has validated.
 *
 * Runner protocol (freeze doc, section H): persist PENDING (with state + event, in
 * one transaction) -> invoke synchronously with a bound -> validate the response ->
 * persist PASSED/FAILED/ERROR (again transactionally, only if still PENDING).
 * A run whose completion never lands is reconciled to ERROR(STRANDED) after a bound.
 */

import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  RunTestsRequestSchema,
  SaveConfigRequestSchema,
  SaveConfigResponseSchema,
  TestRunResponseSchema,
} from "@onboardos/contracts";
import {
  SYSTEM_ACTOR,
  TEST_RUN_ID_PATTERN,
  reduceScenario,
  type RunnerRequest,
  type WorkplaceState,
} from "@onboardos/scenario-engine";
import { NOT_FOUND } from "../authz.js";
import type { ApiDeps } from "../deps.js";
import { loadHistory } from "../history.js";
import { HttpError, json, parseBody, pathParam, type HttpResult } from "../http.js";
import { testRunIdFor } from "../ids.js";
import {
  buildConfigRevisionRecord,
  buildPendingRun,
  buildTerminalRun,
  eventItem,
  parseSessionState,
  parseTestRun,
  sessionItem,
  toSessionView,
  toTestRunView,
  type RunOutcome,
  type TestRunRecord,
} from "../records.js";
import {
  CREATE_ONLY,
  ONLY_IF_PENDING,
  getSessionItem,
  getTestRunItem,
  isTransactionCanceled,
  transactApplyAction,
} from "../repo.js";
import { executeRun } from "../runner.js";
import { INTERNAL, loadOwnedSession, scenarioFor } from "./sessions.js";
import { rejectionToError } from "./rejections.js";

/**
 * A PENDING run older than this cannot still be executing: the API function's own
 * timeout is 29 s and the runner call is bounded at 15 s.
 */
export const STRANDED_AFTER_MS = 60_000;
const COMPLETE_ATTEMPTS = 3;

function isStranded(run: TestRunRecord, nowIso: string): boolean {
  return run.status === "PENDING" && Date.parse(nowIso) - Date.parse(run.createdAt) > STRANDED_AFTER_MS;
}

async function reloadState(deps: ApiDeps, sessionId: string): Promise<WorkplaceState> {
  const state = parseSessionState(await getSessionItem(deps.db, sessionId));
  if (!state) throw INTERNAL("stored session is missing or malformed");
  return state;
}

// ---------------------------------------------------------------------------
// PUT /v1/sessions/{sessionId}/config
// ---------------------------------------------------------------------------

export async function handleSaveConfig(event: APIGatewayProxyEventV2, deps: ApiDeps): Promise<HttpResult> {
  const { state, sub } = await loadOwnedSession(deps, event);
  const body = parseBody(event, SaveConfigRequestSchema);
  const scenario = scenarioFor(state.scenarioId, state.scenarioVersion);
  const now = deps.now();

  const result = reduceScenario(
    scenario,
    state,
    { type: "SAVE_CONFIG", config: body.config, expectedVersion: body.expectedStateVersion },
    { now, actorSub: sub },
  );
  if (!result.ok) throw rejectionToError(result.error);

  try {
    await transactApplyAction(deps.db, {
      nextSessionItem: sessionItem(result.nextState),
      eventItems: result.events.map((e) => eventItem(result.nextState, e)),
      expectedVersion: state.stateVersion,
      employeeSub: sub,
      // The revision commits with the state change: an item with no state, or state with no
      // item, cannot exist. create-if-absent makes revisions immutable.
      extraCorePuts: [{ item: buildConfigRevisionRecord(result.nextState, sub, now) as Record<string, unknown>, condition: CREATE_ONLY }],
    });
  } catch (err) {
    if (!isTransactionCanceled(err)) throw err;
    const latest = parseSessionState(await getSessionItem(deps.db, state.sessionId));
    if (latest && latest.stateVersion !== state.stateVersion) {
      throw new HttpError(409, "VERSION_CONFLICT", "Session state has changed; reload and retry");
    }
    throw err;
  }

  const history = await loadHistory(deps.db, state.sessionId, state.assignmentId);
  return json(200, SaveConfigResponseSchema.parse({ session: toSessionView(result.nextState, scenario, history) }));
}

// ---------------------------------------------------------------------------
// Completion (shared by POST, GET-reconcile)
// ---------------------------------------------------------------------------

/**
 * Record a run's terminal outcome. Idempotent: if the run is already terminal
 * (a retry, or a racing reconcile) nothing is written and the stored record wins.
 * Retries on a state-version race with a save/other writer, re-reading each time.
 */
async function completeTestRun(
  deps: ApiDeps,
  sessionId: string,
  testRunId: string,
  outcome: RunOutcome,
): Promise<void> {
  for (let attempt = 0; attempt < COMPLETE_ATTEMPTS; attempt++) {
    const state = await reloadState(deps, sessionId);
    const run = parseTestRun(await getTestRunItem(deps.db, sessionId, testRunId));
    if (!run) throw INTERNAL("test run is missing or malformed");
    if (run.status !== "PENDING") return;

    const scenario = scenarioFor(state.scenarioId, state.scenarioVersion);
    const now = deps.now();
    const result = reduceScenario(
      scenario,
      state,
      {
        type: "RECORD_TEST_RESULT",
        testRunId,
        outcome: outcome.kind === "ERROR" ? "ERROR" : outcome.status,
        ...(outcome.kind === "ERROR" ? { errorCode: outcome.errorCode } : {}),
        expectedVersion: state.stateVersion,
      },
      { now, actorSub: SYSTEM_ACTOR },
    );
    if (!result.ok) throw INTERNAL(`engine refused to record a result: ${result.error.code}`);

    try {
      await transactApplyAction(deps.db, {
        nextSessionItem: sessionItem(result.nextState),
        eventItems: result.events.map((e) => eventItem(result.nextState, e)),
        expectedVersion: state.stateVersion,
        // A PENDING run can be completed exactly once, whoever gets there first.
        extraCorePuts: [{ item: buildTerminalRun(run, outcome, now) as Record<string, unknown>, ...ONLY_IF_PENDING }],
      });
      return;
    } catch (err) {
      if (!isTransactionCanceled(err)) throw err;
      // Raced with another writer (a save, or a concurrent completion): re-read and decide again.
    }
  }
  throw INTERNAL("could not record the test result");
}

/** Close the session's active run if it is stranded. Returns true if it did. */
async function reconcileStranded(deps: ApiDeps, state: WorkplaceState): Promise<boolean> {
  if (state.activeTestRunId === null) return false;
  const run = parseTestRun(await getTestRunItem(deps.db, state.sessionId, state.activeTestRunId));
  if (!run) throw INTERNAL("active test run is missing or malformed");
  if (!isStranded(run, deps.now())) return false;
  await completeTestRun(deps, state.sessionId, run.testRunId, { kind: "ERROR", errorCode: "STRANDED" });
  return true;
}

async function respondWithRun(deps: ApiDeps, sessionId: string, testRunId: string, status: number): Promise<HttpResult> {
  const state = await reloadState(deps, sessionId);
  const scenario = scenarioFor(state.scenarioId, state.scenarioVersion);
  const history = await loadHistory(deps.db, sessionId, state.assignmentId);
  const run = history.runs.find((r) => r.testRunId === testRunId);
  if (!run) throw INTERNAL("test run is missing or malformed");
  return json(
    status,
    TestRunResponseSchema.parse({
      testRun: toTestRunView(run, state, scenario),
      session: toSessionView(state, scenario, history),
    }),
  );
}

// ---------------------------------------------------------------------------
// POST /v1/sessions/{sessionId}/test-runs
// ---------------------------------------------------------------------------

export async function handleRunTests(event: APIGatewayProxyEventV2, deps: ApiDeps): Promise<HttpResult> {
  const { state, sub } = await loadOwnedSession(deps, event);
  const body = parseBody(event, RunTestsRequestSchema);
  const scenario = scenarioFor(state.scenarioId, state.scenarioVersion);

  // Obtain the runner BEFORE writing anything: a misconfigured runner then fails with
  // a 500 and leaves no PENDING run behind.
  const runner = deps.runner();

  // A previous run that never completed must not block the session forever.
  if (await reconcileStranded(deps, state)) {
    throw new HttpError(409, "VERSION_CONFLICT", "A stalled test run was closed; reload and retry");
  }

  const testRunId = testRunIdFor(state.sessionId, state.testRunsRequested + 1);
  const now = deps.now();
  const requested = reduceScenario(
    scenario,
    state,
    { type: "REQUEST_TEST_RUN", testRunId, expectedVersion: body.expectedStateVersion },
    { now, actorSub: sub },
  );
  if (!requested.ok) throw rejectionToError(requested.error);

  const pending = buildPendingRun({ state: requested.nextState, testRunId, requestedBySub: sub, scenario, now });

  try {
    await transactApplyAction(deps.db, {
      nextSessionItem: sessionItem(requested.nextState),
      eventItems: requested.events.map((e) => eventItem(requested.nextState, e)),
      expectedVersion: state.stateVersion,
      employeeSub: sub,
      extraCorePuts: [{ item: pending as Record<string, unknown>, condition: CREATE_ONLY }],
    });
  } catch (err) {
    if (!isTransactionCanceled(err)) throw err;
    const latest = parseSessionState(await getSessionItem(deps.db, state.sessionId));
    if (latest && latest.stateVersion !== state.stateVersion) {
      throw new HttpError(409, "VERSION_CONFLICT", "Session state has changed; reload and retry");
    }
    throw err;
  }

  // The runner receives the snapshot persisted with the PENDING run, never anything
  // the browser supplied.
  const request: RunnerRequest = {
    testRunId,
    scenarioId: pending.scenarioId,
    scenarioVersion: pending.scenarioVersion,
    suiteId: pending.suiteId,
    suiteVersion: pending.suiteVersion,
    configSnapshot: pending.configSnapshot,
    configHash: pending.configHash,
  };
  const outcome = await executeRun(runner, request);
  await completeTestRun(deps, state.sessionId, testRunId, outcome);

  return respondWithRun(deps, state.sessionId, testRunId, 201);
}

// ---------------------------------------------------------------------------
// GET /v1/sessions/{sessionId}/test-runs/{runId}
// ---------------------------------------------------------------------------

export async function handleGetTestRun(event: APIGatewayProxyEventV2, deps: ApiDeps): Promise<HttpResult> {
  const { state } = await loadOwnedSession(deps, event);
  const testRunId = pathParam(event, "runId") ?? "";
  if (!TEST_RUN_ID_PATTERN.test(testRunId)) throw NOT_FOUND();

  // Keyed under the caller's OWN session partition: another session's run id resolves to nothing.
  const item = await getTestRunItem(deps.db, state.sessionId, testRunId);
  if (!item) throw NOT_FOUND();
  const run = parseTestRun(item);
  if (!run) throw INTERNAL("stored test run is malformed");

  if (isStranded(run, deps.now())) {
    await completeTestRun(deps, state.sessionId, testRunId, { kind: "ERROR", errorCode: "STRANDED" });
  }
  return respondWithRun(deps, state.sessionId, testRunId, 200);
}
