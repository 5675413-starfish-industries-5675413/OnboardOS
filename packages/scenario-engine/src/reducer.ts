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

  // 2. Ownership, before anything that could reveal state to a non-owner.
  if (ctx.actorSub !== state.employeeSub) {
    return reject("NOT_OWNER", "Only the assigned employee can act on this session");
  }

  // 3. Optimistic concurrency.
  if (action.expectedVersion !== state.stateVersion) {
    return reject(
      "VERSION_CONFLICT",
      "Session state has changed; reload and retry",
      state.stateVersion,
    );
  }

  // 4. Bounded growth.
  if (state.stateVersion >= MAX_STATE_VERSION) {
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
