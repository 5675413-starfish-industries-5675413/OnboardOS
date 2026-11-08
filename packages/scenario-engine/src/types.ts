import type { IncidentConfig, ScenarioPublic, SessionPhase, Viewed } from "@onboardos/contracts";

/**
 * A published, versioned scenario definition -- the engine's read-only input.
 *
 * `content` is the employee-visible material. The remaining fields are opaque
 * identifiers a later slice uses to bind test results to an exact suite and
 * rubric version. There is deliberately NO field that can hold hidden test
 * cases, expected outputs, or rubric text.
 */
export interface PublishedScenario {
  readonly content: ScenarioPublic;
  readonly testSuiteId: string;
  readonly testSuiteVersion: number;
  readonly rubricVersion: number;
}

/** The authoritative state of one workplace session. Always treated as immutable. */
export interface WorkplaceState {
  readonly sessionId: string;
  readonly assignmentId: string;
  readonly organizationId: string;
  /** The only identity allowed to act on this session. */
  readonly employeeSub: string;
  readonly scenarioId: string;
  /** Frozen for the life of the session (published versions never change under a running assignment). */
  readonly scenarioVersion: number;
  readonly phase: SessionPhase;
  /** Optimistic-concurrency token; equals the number of successful actions so far. */
  readonly stateVersion: number;
  readonly config: Readonly<IncidentConfig>;
  readonly viewed: Readonly<Viewed>;
  readonly startedAt: string | null;
  readonly updatedAt: string;
}

/**
 * Semantic actions the engine understands. Every action carries the version it
 * was based on, so a stale or concurrent request is rejected, never merged.
 *
 * Config edits and report submission arrive in later slices; they are
 * intentionally not representable here yet.
 */
export type WorkplaceAction =
  | { readonly type: "START_INVESTIGATION"; readonly expectedVersion: number }
  | { readonly type: "OPEN_TICKET"; readonly ticketId: string; readonly expectedVersion: number }
  | { readonly type: "OPEN_RUNBOOK"; readonly runbookId: string; readonly expectedVersion: number }
  | { readonly type: "OPEN_DIAGNOSTICS"; readonly diagnosticsId: string; readonly expectedVersion: number };

export type EventType =
  | "INVESTIGATION_STARTED"
  | "TICKET_OPENED"
  | "RUNBOOK_OPENED"
  | "DIAGNOSTICS_OPENED";

/**
 * A server-originated record of one successful action. `sequence` always equals
 * the state version the action produced, so the event stream and the state
 * version can never disagree.
 */
export interface DomainEvent {
  readonly sessionId: string;
  readonly sequence: number;
  readonly type: EventType;
  readonly occurredAt: string;
  readonly actorSub: string;
  readonly payload: Readonly<Record<string, string | number | boolean>>;
}

/** Facts the engine cannot know by itself. Supplied by the caller so the engine stays pure. */
export interface TransitionContext {
  /** ISO-8601 timestamp of the action, from the server clock. */
  readonly now: string;
  /** Verified identity performing the action. */
  readonly actorSub: string;
}

export type RejectionCode =
  | "VERSION_CONFLICT"
  | "INVALID_TRANSITION"
  | "UNKNOWN_OBJECT"
  | "LIMIT_REACHED"
  | "NOT_OWNER"
  | "SCENARIO_MISMATCH";

export interface Rejection {
  readonly code: RejectionCode;
  readonly message: string;
  /** Present only for VERSION_CONFLICT, and only after ownership was established. */
  readonly currentVersion?: number;
}

export type TransitionResult =
  | { readonly ok: true; readonly nextState: WorkplaceState; readonly events: readonly DomainEvent[] }
  | { readonly ok: false; readonly error: Rejection };

/** Identifiers the server assigns when it creates a session. */
export interface SessionInit {
  readonly sessionId: string;
  readonly assignmentId: string;
  readonly organizationId: string;
  readonly employeeSub: string;
}
