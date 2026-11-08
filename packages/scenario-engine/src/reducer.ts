/**
 * The deterministic scenario reducer.
 *
 * PURE: no I/O, no AWS, no clock, no randomness, no mutation of its inputs.
 * Given the same (definition, state, action, context) it always returns the
 * same result. Time and identity are passed in by the caller.
 *
 * Invariants enforced here (architecture freeze section E):
 *  - Every successful action increments stateVersion by exactly one and
 *    produces exactly one server-originated event whose sequence equals the new
 *    version.
 *  - A stale or concurrent action (expectedVersion != stateVersion) is rejected
 *    with VERSION_CONFLICT; it is never merged.
 *  - The scenario version is frozen for the life of a session.
 *  - Only the owning employee may act. (The API authorizes first; this is
 *    defense in depth, so the engine can be tested without an API.)
 */

import { configHash, validateConfig } from "./config.js";
import { SYSTEM_ACTOR } from "./types.js";
import type {
  DomainEvent,
  PublishedScenario,
  Rejection,
  SessionInit,
  TransitionContext,
  TransitionResult,
  WorkplaceAction,
  WorkplaceState,
} from "./types.js";

/**
 * Hard cap on actions per session. Bounds event-table growth and stops a
 * client from generating unbounded writes by repeating a valid action.
 */
export const MAX_STATE_VERSION = 200;

/** Bounded history: at most this many test runs / saved revisions per session. */
export const MAX_TEST_RUNS = 20;
export const MAX_CONFIG_REVISIONS = 30;

function reject(code: Rejection["code"], message: string, currentVersion?: number): TransitionResult {
  return {
    ok: false,
    error: currentVersion === undefined ? { code, message } : { code, message, currentVersion },
  };
}

/**
 * Create a session in its pre-start state (version 0, no events). Callers
 * normally use {@link startSession}, which also applies START_INVESTIGATION.
 */
export function createSession(
  definition: PublishedScenario,
  init: SessionInit,
  now: string,
): WorkplaceState {
  return {
    sessionId: init.sessionId,
    assignmentId: init.assignmentId,
    organizationId: init.organizationId,
    employeeSub: init.employeeSub,
    scenarioId: definition.content.scenarioId,
    scenarioVersion: definition.content.version,
    phase: "NOT_STARTED",
    stateVersion: 0,
    // Copy: the definition is shared and must never be aliased by session state.
    config: { ...definition.content.initialConfig },
    configRevision: 0,
    configHash: configHash(definition.content.initialConfig),
    testRunsRequested: 0,
    activeTestRunId: null,
    viewed: { ticket: false, runbook: false, diagnostics: false },
    startedAt: null,
    updatedAt: now,
  };
}

export function reduceScenario(
  definition: PublishedScenario,
  state: WorkplaceState,
  action: WorkplaceAction,
  ctx: TransitionContext,
): TransitionResult {
  // 1. The session is bound to exactly one scenario version.
  if (
    state.scenarioId !== definition.content.scenarioId ||
    state.scenarioVersion !== definition.content.version
  ) {
    return reject("SCENARIO_MISMATCH", "Session is bound to a different scenario version");
  }

  // 2. Authority, before anything that could reveal state to a non-owner.
  //    System actions need the system identity; client actions need the owner
  //    and can never be performed by the system identity.
  const isSystemAction = action.type === "RECORD_TEST_RESULT";
  if (isSystemAction) {
    if (ctx.actorSub !== SYSTEM_ACTOR) {
      return reject("NOT_AUTHORIZED", "Only the system can record test results");
    }
  } else {
    if (ctx.actorSub === SYSTEM_ACTOR) {
      return reject("NOT_AUTHORIZED", "The system identity cannot perform employee actions");
    }
    if (ctx.actorSub !== state.employeeSub) {
      return reject("NOT_OWNER", "Only the assigned employee can act on this session");
    }
  }

  // 3. Optimistic concurrency.
  if (action.expectedVersion !== state.stateVersion) {
    return reject(
      "VERSION_CONFLICT",
      "Session state has changed; reload and retry",
      state.stateVersion,
    );
  }

  // 4. Bounded growth. Recording a result is exempt: a requested run must
  //    always be completable, and completions are bounded by MAX_TEST_RUNS.
  if (!isSystemAction && state.stateVersion >= MAX_STATE_VERSION) {
    return reject("LIMIT_REACHED", "This session has reached its maximum number of actions");
  }

  const nextVersion = state.stateVersion + 1;
  const base = { sessionId: state.sessionId, sequence: nextVersion, occurredAt: ctx.now, actorSub: ctx.actorSub };

  switch (action.type) {
    case "START_INVESTIGATION": {
      if (state.phase !== "NOT_STARTED") {
        return reject("INVALID_TRANSITION", "Investigation has already started");
      }
      const event: DomainEvent = {
        ...base,
        type: "INVESTIGATION_STARTED",
        payload: { scenarioId: state.scenarioId, scenarioVersion: state.scenarioVersion },
      };
      return {
        ok: true,
        nextState: { ...state, phase: "INVESTIGATING", stateVersion: nextVersion, startedAt: ctx.now, updatedAt: ctx.now },
        events: [event],
      };
    }

    case "OPEN_TICKET":
    case "OPEN_RUNBOOK":
    case "OPEN_DIAGNOSTICS": {
      if (state.phase !== "INVESTIGATING") {
        return reject("INVALID_TRANSITION", "Start the investigation before opening incident material");
      }

      const content = definition.content;
      let eventType: DomainEvent["type"];
      let viewedKey: "ticket" | "runbook" | "diagnostics";
      let objectId: string;
      let known: string;
      let payloadKey: string;

      if (action.type === "OPEN_TICKET") {
        eventType = "TICKET_OPENED"; viewedKey = "ticket"; objectId = action.ticketId;
        known = content.ticket.id; payloadKey = "ticketId";
      } else if (action.type === "OPEN_RUNBOOK") {
        eventType = "RUNBOOK_OPENED"; viewedKey = "runbook"; objectId = action.runbookId;
        known = content.runbook.id; payloadKey = "runbookId";
      } else {
        eventType = "DIAGNOSTICS_OPENED"; viewedKey = "diagnostics"; objectId = action.diagnosticsId;
        known = content.diagnostics.id; payloadKey = "diagnosticsId";
      }

      if (objectId !== known) {
        return reject("UNKNOWN_OBJECT", "That item does not exist in this scenario");
      }

      const event: DomainEvent = { ...base, type: eventType, payload: { [payloadKey]: objectId } };
      return {
        ok: true,
        nextState: {
          ...state,
          viewed: { ...state.viewed, [viewedKey]: true },
          stateVersion: nextVersion,
          updatedAt: ctx.now,
        },
        events: [event],
      };
    }

    case "SAVE_CONFIG": {
      if (state.phase !== "INVESTIGATING") {
        return reject("INVALID_TRANSITION", "Start the investigation before editing configuration");
      }
      const checked = validateConfig(action.config);
      if (!checked.ok) return reject(checked.code, checked.message);
      const hash = configHash(checked.config);
      if (hash === state.configHash) {
        return reject("CONFIG_UNCHANGED", "That configuration is already the current revision");
      }
      if (state.configRevision >= MAX_CONFIG_REVISIONS) {
        return reject("REVISION_LIMIT_REACHED", "This session has reached its maximum number of saved revisions");
      }
      const revision = state.configRevision + 1;
      const event: DomainEvent = {
        ...base,
        type: "CONFIG_SAVED",
        payload: { revision, configHash: hash, request_timeout_ms: checked.config.request_timeout_ms },
      };
      return {
        ok: true,
        nextState: {
          ...state,
          config: { ...checked.config },
          configRevision: revision,
          configHash: hash,
          stateVersion: nextVersion,
          updatedAt: ctx.now,
        },
        events: [event],
      };
    }

    case "REQUEST_TEST_RUN": {
      if (state.phase !== "INVESTIGATING") {
        return reject("INVALID_TRANSITION", "Start the investigation before running tests");
      }
      if (state.activeTestRunId !== null) {
        return reject("RUN_IN_PROGRESS", "A test run is already in progress");
      }
      if (state.testRunsRequested >= MAX_TEST_RUNS) {
        return reject("RUN_LIMIT_REACHED", "This session has reached its maximum number of test runs");
      }
      const event: DomainEvent = {
        ...base,
        type: "TEST_RUN_REQUESTED",
        payload: { testRunId: action.testRunId, configRevision: state.configRevision, configHash: state.configHash },
      };
      return {
        ok: true,
        nextState: {
          ...state,
          testRunsRequested: state.testRunsRequested + 1,
          activeTestRunId: action.testRunId,
          stateVersion: nextVersion,
          updatedAt: ctx.now,
        },
        events: [event],
      };
    }

    case "RECORD_TEST_RESULT": {
      if (state.activeTestRunId === null || state.activeTestRunId !== action.testRunId) {
        return reject("INVALID_TRANSITION", "That test run is not awaiting a result");
      }
      const payload: Record<string, string> = { testRunId: action.testRunId, outcome: action.outcome };
      if (action.errorCode !== undefined) payload.errorCode = action.errorCode;
      const event: DomainEvent = { ...base, type: "TEST_RUN_COMPLETED", payload };
      return {
        ok: true,
        nextState: { ...state, activeTestRunId: null, stateVersion: nextVersion, updatedAt: ctx.now },
        events: [event],
      };
    }
  }
}

/**
 * Create a session and immediately apply START_INVESTIGATION. This is the one
 * path the API uses to begin work, so a started session is always version 1
 * with exactly one INVESTIGATION_STARTED event.
 */
export function startSession(
  definition: PublishedScenario,
  init: SessionInit,
  ctx: TransitionContext,
): TransitionResult {
  const initial = createSession(definition, init, ctx.now);
  return reduceScenario(definition, initial, { type: "START_INVESTIGATION", expectedVersion: 0 }, ctx);
}
