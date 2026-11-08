import type { IncidentConfig, ReviewDecision, ScenarioPublic, SessionPhase, Viewed } from "@onboardos/contracts";

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
  /** Number of saved immutable revisions. 0 = the scenario baseline (never stored as an item). */
  readonly configRevision: number;
  /** `sha256:<hex>` of the canonical current config; always recomputable from `config`. */
  readonly configHash: string;
  /** Test runs requested so far (monotonic; bounds run history and numbers run ids). */
  readonly testRunsRequested: number;
  /** The one run awaiting a result, or null. At most one run is in flight. */
  readonly activeTestRunId: string | null;
  /** 1 for the first attempt. A revision request opens attempt N+1 as a NEW session. */
  readonly attemptNumber: number;
  /** The frozen submission that locked this attempt, or null while it is still open. */
  readonly submissionId: string | null;
  /** The manager's decision on that submission, or null while awaiting review. Set exactly once. */
  readonly reviewDecision: ReviewDecision | null;
  readonly viewed: Readonly<Viewed>;
  readonly startedAt: string | null;
  readonly updatedAt: string;
}

/**
 * Identity of the trusted backend component that records runner outcomes.
 * Browser-originated actions can never carry it; client actions can never be
 * performed by it.
 */
export const SYSTEM_ACTOR = "system:scenario-runner";

export type TestOutcome = "PASSED" | "FAILED" | "ERROR";

/**
 * Semantic actions the engine understands. Every action carries the version it
 * was based on, so a stale or concurrent request is rejected, never merged.
 *
 * SAVE_CONFIG carries an UNTRUSTED `config`; the engine validates it.
 * RECORD_TEST_RESULT is a SYSTEM action: only SYSTEM_ACTOR may perform it.
 */
export type WorkplaceAction =
  | { readonly type: "START_INVESTIGATION"; readonly expectedVersion: number }
  | { readonly type: "OPEN_TICKET"; readonly ticketId: string; readonly expectedVersion: number }
  | { readonly type: "OPEN_RUNBOOK"; readonly runbookId: string; readonly expectedVersion: number }
  | { readonly type: "OPEN_DIAGNOSTICS"; readonly diagnosticsId: string; readonly expectedVersion: number }
  | { readonly type: "SAVE_CONFIG"; readonly config: unknown; readonly expectedVersion: number }
  | { readonly type: "REQUEST_TEST_RUN"; readonly testRunId: string; readonly expectedVersion: number }
  | { readonly type: "SUBMIT_REPORT"; readonly submissionId: string; readonly expectedVersion: number }
  | {
      /** A REVIEWER action: performed by someone other than the employee and never by the system identity. */
      readonly type: "RECORD_REVIEW";
      readonly submissionId: string;
      readonly decision: ReviewDecision;
      readonly expectedVersion: number;
    }
  | {
      readonly type: "RECORD_TEST_RESULT";
      readonly testRunId: string;
      readonly outcome: TestOutcome;
      readonly errorCode?: string;
      readonly expectedVersion: number;
    };

export type EventType =
  | "INVESTIGATION_STARTED"
  | "TICKET_OPENED"
  | "RUNBOOK_OPENED"
  | "DIAGNOSTICS_OPENED"
  | "CONFIG_SAVED"
  | "TEST_RUN_REQUESTED"
  | "TEST_RUN_COMPLETED"
  | "SUBMISSION_CREATED"
  | "REVIEW_DECIDED";

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
  | "NOT_AUTHORIZED"
  | "SCENARIO_MISMATCH"
  | "INVALID_CONFIG"
  | "CONFIG_OUT_OF_POLICY"
  | "CONFIG_UNCHANGED"
  | "RUN_IN_PROGRESS"
  | "RUN_LIMIT_REACHED"
  | "REVISION_LIMIT_REACHED"
  | "ALREADY_DECIDED";

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
  /** Defaults to 1. Later attempts are separate sessions on the same assignment. */
  readonly attemptNumber?: number;
}
