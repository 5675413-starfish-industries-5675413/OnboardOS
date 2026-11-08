/**
 * Persisted record shapes, their validation, and the projections that leave the API.
 *
 * Nothing read from DynamoDB is trusted by TypeScript cast. Every record is
 * parsed with Zod and its key attributes are cross-checked against its content;
 * a record that fails is treated as absent (lists) or as a server fault
 * (single fetch). Nothing malformed is ever returned or authorized against.
 *
 * Outbound bodies are produced by parsing through the shared contract schemas,
 * which STRIP unknown keys -- so an internal attribute (index keys, manager
 * identity, suite ids) cannot leak by accident.
 */

import { z } from "zod";
import {
  AssignmentStatusSchema,
  AssignmentViewSchema,
  IncidentConfigSchema,
  MembershipStatusSchema,
  OrgRoleSchema,
  ScenarioIdSchema,
  SessionPhaseSchema,
  SessionViewSchema,
  FrozenTestRunSchema,
  IncidentReportSchema,
  EvaluationStatusSchema,
  ReviewDecisionSchema,
  SubmissionViewSchema,
  SubmissionSummarySchema,
  TestCaseResultSchema,
  TestRunViewSchema,
  ConfigRevisionViewSchema,
  UserSubSchema,
  ViewedSchema,
  type AssignmentView,
  type FrozenTestRun,
  type IncidentReport,
  type ReviewDecision,
  type SessionView,
  type SubmissionSummary,
  type SubmissionView,
  type TestRunView,
} from "@onboardos/contracts";
import {
  CONFIG_HASH_PATTERN,
  TEST_RUN_ID_PATTERN,
  configHash,
  isCurrentRun,
  type DomainEvent,
  type PublishedScenario,
  type RunnerCase,
  type WorkplaceState,
} from "@onboardos/scenario-engine";
import { ASSIGNMENT_ID_PATTERN, SESSION_ID_PATTERN, SUBMISSION_ID_PATTERN, submissionIdFor } from "./ids.js";

// ---------------------------------------------------------------------------
// Key builders (single source of truth for the access patterns in docs/04)
// ---------------------------------------------------------------------------

export const keys = {
  member: (orgId: string, sub: string) => ({ PK: `ORG#${orgId}`, SK: `MEMBER#${sub}` }),
  assignment: (assignmentId: string) => ({ PK: `ASSIGN#${assignmentId}`, SK: "META" as const }),
  session: (sessionId: string) => ({ PK: `SESSION#${sessionId}`, SK: "STATE" as const }),
  /** Immutable saved revision N (1-based). 10-digit padding keeps lexical order == numeric order. */
  revision: (sessionId: string, revision: number) => ({
    PK: `SESSION#${sessionId}`,
    SK: `CONFIG#${String(revision).padStart(10, "0")}`,
  }),
  /** One test run. Run ids start with a zero-padded run number, so key order == creation order. */
  testRun: (sessionId: string, testRunId: string) => ({ PK: `SESSION#${sessionId}`, SK: `TEST#${testRunId}` }),
  /**
   * A frozen submission and its (single) decision live in the ASSIGNMENT's partition, one
   * slot per attempt. Create-if-absent on these keys is what makes them immutable and
   * what makes a second decision impossible. (Doc 04 sketches SESSION#/SUBMISSION#; see ADR-029.)
   */
  submission: (assignmentId: string, attempt: number) => ({
    PK: `ASSIGN#${assignmentId}`,
    SK: `SUBMISSION#${String(attempt).padStart(2, "0")}`,
  }),
  decision: (assignmentId: string, attempt: number) => ({
    PK: `ASSIGN#${assignmentId}`,
    SK: `DECISION#${String(attempt).padStart(2, "0")}`,
  }),
  /** Persistent idempotency ledger for report submission, scoped to the session (and so to the employee). */
  submitLedger: (sessionId: string, key: string) => ({ PK: `SESSION#${sessionId}`, SK: `IDEM#SUBMIT#${key}` }),
  event: (sessionId: string, sequence: number) => ({
    PK: `SESSION#${sessionId}`,
    SK: `SEQ#${String(sequence).padStart(10, "0")}`,
  }),
  /** GSI1: an employee's assignments within an organization. */
  employeeIndex: (orgId: string, employeeSub: string) => `ORG#${orgId}#EMP#${employeeSub}`,
  /**
   * GSI2: a manager's partition. Assignment entries use the "ASSIGN#" sort-key
   * prefix. The frozen design reserves "REVIEWABLE#" entries in the same
   * partition for the review queue; that slice will move an assignment's GSI2SK
   * to that prefix when it becomes reviewable.
   */
  managerIndex: (orgId: string, managerSub: string) => `ORG#${orgId}#MANAGER#${managerSub}`,
};

// ---------------------------------------------------------------------------
// Membership (read-only here; written only by operator tooling)
// ---------------------------------------------------------------------------

const MemberItemSchema = z.looseObject({
  PK: z.string(),
  SK: z.string().startsWith("MEMBER#"),
  role: OrgRoleSchema,
  status: MembershipStatusSchema,
  // Required (not defaulted): a membership without a valid team list is malformed.
  teamIds: z.array(z.string()),
  preferredUsername: z.string().optional(),
});

export interface Member {
  organizationId: string;
  userSub: string;
  role: z.infer<typeof OrgRoleSchema>;
  status: z.infer<typeof MembershipStatusSchema>;
  teamIds: string[];
  /** Safe-to-show name. Never the email address. */
  displayName: string;
}

/** Parse a membership item. The org and sub come from the KEY, which is authoritative. */
export function parseMember(item: unknown): Member | null {
  const parsed = MemberItemSchema.safeParse(item);
  if (!parsed.success) return null;
  const { PK, SK, role, status, teamIds, preferredUsername } = parsed.data;
  if (!PK.startsWith("ORG#")) return null;
  const organizationId = PK.slice("ORG#".length);
  const userSub = SK.slice("MEMBER#".length);
  if (!UserSubSchema.safeParse(userSub).success) return null;
  return {
    organizationId,
    userSub,
    role,
    status,
    teamIds,
    displayName: preferredUsername && preferredUsername.trim() ? preferredUsername.trim() : "Employee",
  };
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/** The immutable organization-published coaching version an assignment was created with. */
export const CoachingRefSchema = z.strictObject({
  source: z.literal("ORG_PUBLISHED"),
  profileId: z.string().min(1).max(64),
  profileVersion: z.number().int().positive(),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type CoachingRef = z.infer<typeof CoachingRefSchema>;

const AssignmentRecordSchema = z
  .looseObject({
    PK: z.string(),
    SK: z.literal("META"),
    entityType: z.literal("ASSIGNMENT"),
    assignmentId: z.string().regex(ASSIGNMENT_ID_PATTERN),
    organizationId: z.string(),
    scenarioId: ScenarioIdSchema,
    scenarioVersion: z.number().int().positive(),
    scenarioTitle: z.string(),
    employeeSub: UserSubSchema,
    employeeDisplayName: z.string(),
    assignedBySub: UserSubSchema,
    status: AssignmentStatusSchema,
    sessionId: z.string().regex(SESSION_ID_PATTERN).nullable(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    updatedAt: z.string(),
    // Phase 2D. Absent on records written before it: attempt 1, nothing submitted.
    attemptNumber: z.number().int().positive().default(1),
    latestSubmissionId: z.string().regex(SUBMISSION_ID_PATTERN).nullable().default(null),
    // Milestone M1. Absent on every assignment created before it (and on any created while the organization had
    // published no coaching): those use the platform's built-in coaching. Set once, at creation; never rewritten.
    coachingRef: CoachingRefSchema.optional(),
    GSI1PK: z.string(),
    GSI1SK: z.string(),
    GSI2PK: z.string(),
    GSI2SK: z.string(),
  })
  // Keys must agree with content, or the record was written wrongly / tampered with.
  .refine(
    (r) =>
      r.PK === keys.assignment(r.assignmentId).PK &&
      r.GSI1PK === keys.employeeIndex(r.organizationId, r.employeeSub) &&
      r.GSI2PK === keys.managerIndex(r.organizationId, r.assignedBySub),
    { message: "assignment keys do not match content" },
  );

export type AssignmentRecord = z.infer<typeof AssignmentRecordSchema>;

export function parseAssignment(item: unknown): AssignmentRecord | null {
  const parsed = AssignmentRecordSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
}

export function buildAssignmentRecord(input: {
  assignmentId: string;
  organizationId: string;
  scenario: PublishedScenario;
  employeeSub: string;
  employeeDisplayName: string;
  assignedBySub: string;
  now: string;
  coachingRef?: CoachingRef | null;
}): AssignmentRecord {
  const { assignmentId, organizationId, scenario, employeeSub, employeeDisplayName, assignedBySub, now } = input;
  return {
    ...keys.assignment(assignmentId),
    entityType: "ASSIGNMENT",
    assignmentId,
    organizationId,
    scenarioId: scenario.content.scenarioId,
    scenarioVersion: scenario.content.version,
    scenarioTitle: scenario.content.title,
    employeeSub,
    employeeDisplayName,
    assignedBySub,
    status: "ASSIGNED",
    sessionId: null,
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    attemptNumber: 1,
    latestSubmissionId: null,
    ...(input.coachingRef ? { coachingRef: input.coachingRef } : {}),
    GSI1PK: keys.employeeIndex(organizationId, employeeSub),
    GSI1SK: `ASSIGN#${now}#${assignmentId}`,
    GSI2PK: keys.managerIndex(organizationId, assignedBySub),
    GSI2SK: `ASSIGN#${now}#${assignmentId}`,
  };
}

/**
 * Client projection. The employee sees their own assignment without the
 * `employee` block; managers/admins get it. The assigning manager's identity
 * and all index attributes are never included.
 */
export function toAssignmentView(r: AssignmentRecord, includeEmployee: boolean): AssignmentView {
  return AssignmentViewSchema.parse({
    assignmentId: r.assignmentId,
    organizationId: r.organizationId,
    scenarioId: r.scenarioId,
    scenarioVersion: r.scenarioVersion,
    scenarioTitle: r.scenarioTitle,
    status: r.status,
    sessionId: r.sessionId,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    attemptNumber: r.attemptNumber,
    latestSubmissionId: r.latestSubmissionId,
    ...(includeEmployee
      ? {
          employee: { userSub: r.employeeSub, displayName: r.employeeDisplayName },
          coaching: r.coachingRef
            ? { source: "ORG_PUBLISHED" as const, profileVersion: r.coachingRef.profileVersion }
            : { source: "BUILT_IN" as const, profileVersion: null },
        }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Session state and events
// ---------------------------------------------------------------------------

const WorkplaceStateSchema = z
  .looseObject({
    PK: z.string(),
    SK: z.literal("STATE"),
    entityType: z.literal("SESSION_STATE"),
    sessionId: z.string().regex(SESSION_ID_PATTERN),
    assignmentId: z.string().regex(ASSIGNMENT_ID_PATTERN),
    organizationId: z.string(),
    employeeSub: UserSubSchema,
    scenarioId: ScenarioIdSchema,
    scenarioVersion: z.number().int().positive(),
    phase: SessionPhaseSchema,
    stateVersion: z.number().int().nonnegative(),
    config: IncidentConfigSchema,
    // Phase 2C fields. OPTIONAL on read so sessions stored by Phase 2B still load;
    // defaults below are exactly the values a fresh session starts with.
    configRevision: z.number().int().nonnegative().optional(),
    configHash: z.string().regex(CONFIG_HASH_PATTERN).optional(),
    testRunsRequested: z.number().int().nonnegative().optional(),
    activeTestRunId: z.string().regex(TEST_RUN_ID_PATTERN).nullable().optional(),
    // Phase 2D, optional for the same reason.
    attemptNumber: z.number().int().positive().optional(),
    submissionId: z.string().regex(SUBMISSION_ID_PATTERN).nullable().optional(),
    reviewDecision: ReviewDecisionSchema.nullable().optional(),
    viewed: ViewedSchema,
    startedAt: z.string().nullable(),
    updatedAt: z.string(),
  })
  .refine((s) => s.PK === keys.session(s.sessionId).PK, { message: "session key does not match content" })
  // A stored hash that disagrees with the stored config means corruption: fail closed.
  .refine((s) => s.configHash === undefined || s.configHash === configHash(s.config), {
    message: "stored configHash does not match stored config",
  });

/** Parse a stored session into the engine's state type (extra storage attributes dropped). */
export function parseSessionState(item: unknown): WorkplaceState | null {
  const parsed = WorkplaceStateSchema.safeParse(item);
  if (!parsed.success) return null;
  const d = parsed.data;
  return {
    sessionId: d.sessionId,
    assignmentId: d.assignmentId,
    organizationId: d.organizationId,
    employeeSub: d.employeeSub,
    scenarioId: d.scenarioId,
    scenarioVersion: d.scenarioVersion,
    phase: d.phase,
    stateVersion: d.stateVersion,
    config: d.config,
    configRevision: d.configRevision ?? 0,
    configHash: configHash(d.config),
    testRunsRequested: d.testRunsRequested ?? 0,
    activeTestRunId: d.activeTestRunId ?? null,
    attemptNumber: d.attemptNumber ?? 1,
    submissionId: d.submissionId ?? null,
    reviewDecision: d.reviewDecision ?? null,
    viewed: d.viewed,
    startedAt: d.startedAt,
    updatedAt: d.updatedAt,
  };
}

export function sessionItem(state: WorkplaceState): Record<string, unknown> {
  return { ...keys.session(state.sessionId), entityType: "SESSION_STATE", ...state };
}

export function eventItem(state: WorkplaceState, event: DomainEvent): Record<string, unknown> {
  return {
    ...keys.event(event.sessionId, event.sequence),
    entityType: "SESSION_EVENT",
    sessionId: event.sessionId,
    organizationId: state.organizationId,
    actorSub: event.actorSub,
    type: event.type,
    stateVersion: event.sequence,
    occurredAt: event.occurredAt,
    payload: event.payload,
  };
}

// ---------------------------------------------------------------------------
// Config revisions (immutable)
// ---------------------------------------------------------------------------

const ConfigRevisionRecordSchema = z
  .looseObject({
    PK: z.string(),
    SK: z.string(),
    entityType: z.literal("CONFIG_REVISION"),
    sessionId: z.string().regex(SESSION_ID_PATTERN),
    organizationId: z.string(),
    revision: z.number().int().positive(),
    config: IncidentConfigSchema,
    configHash: z.string().regex(CONFIG_HASH_PATTERN),
    savedBySub: UserSubSchema,
    savedAt: z.string(),
    stateVersion: z.number().int().positive(),
  })
  .refine(
    (r) => {
      const k = keys.revision(r.sessionId, r.revision);
      return r.PK === k.PK && r.SK === k.SK && r.configHash === configHash(r.config);
    },
    { message: "revision keys/hash do not match content" },
  );
export type ConfigRevisionRecord = z.infer<typeof ConfigRevisionRecordSchema>;

export function parseConfigRevision(item: unknown): ConfigRevisionRecord | null {
  const parsed = ConfigRevisionRecordSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
}

/** Built from the engine's NEXT state, so the stored revision can never disagree with the session. */
export function buildConfigRevisionRecord(next: WorkplaceState, savedBySub: string, savedAt: string): ConfigRevisionRecord {
  return {
    ...keys.revision(next.sessionId, next.configRevision),
    entityType: "CONFIG_REVISION",
    sessionId: next.sessionId,
    organizationId: next.organizationId,
    revision: next.configRevision,
    config: { ...next.config },
    configHash: next.configHash,
    savedBySub,
    savedAt,
    stateVersion: next.stateVersion,
  };
}

// ---------------------------------------------------------------------------
// Test runs
// ---------------------------------------------------------------------------

/** Machine codes stored on an ERROR run, each with one fixed, user-safe message. Raw errors are never stored. */
export const RUN_ERROR_MESSAGES = {
  RUNNER_INVOCATION_FAILED: "The test runner could not be reached. No test results were produced.",
  RUNNER_TIMEOUT: "The test runner did not respond in time. No test results were produced.",
  RUNNER_FUNCTION_ERROR: "The test runner failed while executing. No test results were produced.",
  RUNNER_BAD_RESPONSE: "The test runner returned an unusable response. Its results were discarded.",
  RUNNER_MISMATCH: "The test runner's response did not match the request. Its results were discarded.",
  RUNNER_REJECTED: "The test runner rejected the request. No test results were produced.",
  STRANDED: "The test run did not complete. No test results were produced.",
} as const;
export type RunErrorCode = keyof typeof RUN_ERROR_MESSAGES;

export type RunOutcome =
  | {
      kind: "COMPLETED";
      status: "PASSED" | "FAILED";
      cases: RunnerCase[];
      executor: { region: string; runnerRequestId: string; invokeRequestId: string | null };
    }
  | { kind: "ERROR"; errorCode: RunErrorCode };

const TestRunRecordSchema = z
  .looseObject({
    PK: z.string(),
    SK: z.string(),
    entityType: z.literal("TEST_RUN"),
    sessionId: z.string().regex(SESSION_ID_PATTERN),
    organizationId: z.string(),
    testRunId: z.string().regex(TEST_RUN_ID_PATTERN),
    requestedBySub: UserSubSchema,
    status: z.enum(["PENDING", "PASSED", "FAILED", "ERROR"]),
    scenarioId: ScenarioIdSchema,
    scenarioVersion: z.number().int().positive(),
    /** Internal only: never copied into the client view. */
    suiteId: z.string(),
    suiteVersion: z.number().int().positive(),
    configRevision: z.number().int().nonnegative(),
    configHash: z.string().regex(CONFIG_HASH_PATTERN),
    configSnapshot: IncidentConfigSchema,
    createdAt: z.string(),
    completedAt: z.string().nullable(),
    cases: z.array(TestCaseResultSchema),
    passedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    executor: z
      .object({ region: z.string(), runnerRequestId: z.string(), invokeRequestId: z.string().nullable() })
      .nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
  })
  .refine(
    (r) => {
      const k = keys.testRun(r.sessionId, r.testRunId);
      if (r.PK !== k.PK || r.SK !== k.SK) return false;
      if (r.configHash !== configHash(r.configSnapshot)) return false;
      const passes = r.cases.filter((c) => c.status === "PASS").length;
      if (r.passedCount !== passes || r.totalCount !== r.cases.length) return false;
      // A stored PASSED/FAILED must be consistent with its own cases, or it is not shown.
      if (r.status === "PASSED") return r.totalCount > 0 && passes === r.totalCount && r.executor !== null && r.completedAt !== null;
      if (r.status === "FAILED") return r.totalCount > 0 && passes < r.totalCount && r.executor !== null && r.completedAt !== null;
      if (r.status === "ERROR") return r.totalCount === 0 && r.errorCode !== null && r.completedAt !== null;
      return r.completedAt === null && r.totalCount === 0; // PENDING
    },
    { message: "test run is internally inconsistent" },
  );
export type TestRunRecord = z.infer<typeof TestRunRecordSchema>;

export function parseTestRun(item: unknown): TestRunRecord | null {
  const parsed = TestRunRecordSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
}

/** The PENDING record persisted BEFORE the runner is invoked. */
export function buildPendingRun(input: {
  state: WorkplaceState;
  testRunId: string;
  requestedBySub: string;
  scenario: PublishedScenario;
  now: string;
}): TestRunRecord {
  const { state, testRunId, requestedBySub, scenario, now } = input;
  return {
    ...keys.testRun(state.sessionId, testRunId),
    entityType: "TEST_RUN",
    sessionId: state.sessionId,
    organizationId: state.organizationId,
    testRunId,
    requestedBySub,
    status: "PENDING",
    scenarioId: state.scenarioId,
    scenarioVersion: state.scenarioVersion,
    suiteId: scenario.testSuiteId,
    suiteVersion: scenario.testSuiteVersion,
    // The snapshot is the config AT REQUEST TIME, copied; later edits cannot reach it.
    configRevision: state.configRevision,
    configHash: state.configHash,
    configSnapshot: { ...state.config },
    createdAt: now,
    completedAt: null,
    cases: [],
    passedCount: 0,
    totalCount: 0,
    executor: null,
    errorCode: null,
    errorMessage: null,
  };
}

/** The terminal record that replaces a PENDING one. Identity fields are carried over unchanged. */
export function buildTerminalRun(pending: TestRunRecord, outcome: RunOutcome, now: string): TestRunRecord {
  if (outcome.kind === "ERROR") {
    return {
      ...pending,
      status: "ERROR",
      completedAt: now,
      cases: [],
      passedCount: 0,
      totalCount: 0,
      executor: null,
      errorCode: outcome.errorCode,
      errorMessage: RUN_ERROR_MESSAGES[outcome.errorCode],
    };
  }
  const cases = outcome.cases.map((c) => ({ caseId: c.caseId, name: c.name, status: c.status, message: c.message }));
  return {
    ...pending,
    status: outcome.status,
    completedAt: now,
    cases,
    passedCount: cases.filter((c) => c.status === "PASS").length,
    totalCount: cases.length,
    executor: { ...outcome.executor },
    errorCode: null,
    errorMessage: null,
  };
}

/**
 * Client projection of one run. `current`/`stale` are DERIVED here from the
 * session's present revision/hash and the scenario's suite version; nothing about
 * staleness is stored, so history is never rewritten.
 */
export function toTestRunView(r: TestRunRecord, state: WorkplaceState, scenario: PublishedScenario): TestRunView {
  const current = isCurrentRun(r, state, scenario.testSuiteVersion);
  return TestRunViewSchema.parse({
    testRunId: r.testRunId,
    status: r.status,
    configRevision: r.configRevision,
    configHash: r.configHash,
    configSnapshot: r.configSnapshot,
    suiteVersion: r.suiteVersion,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    cases: r.cases,
    passedCount: r.passedCount,
    totalCount: r.totalCount,
    executor: r.executor ? { kind: "AWS_LAMBDA", ...r.executor } : null,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    current,
    stale: r.status !== "PENDING" && !current,
  });
}

// ---------------------------------------------------------------------------
// Frozen submissions, decisions and the idempotency ledger
// ---------------------------------------------------------------------------

export const MANIFEST_VERSION = 1;

export const EVALUATION_NOT_CONFIGURED = {
  status: "NOT_CONFIGURED" as const,
  message:
    "AI-assisted evaluation is not configured for this deployment. A human manager reviews the frozen evidence directly.",
};

const SubmissionRecordSchema = z
  .looseObject({
    PK: z.string(),
    SK: z.string(),
    entityType: z.literal("SUBMISSION"),
    submissionId: z.string().regex(SUBMISSION_ID_PATTERN),
    attemptNumber: z.number().int().positive(),
    sessionId: z.string().regex(SESSION_ID_PATTERN),
    assignmentId: z.string().regex(ASSIGNMENT_ID_PATTERN),
    organizationId: z.string(),
    employeeSub: UserSubSchema,
    scenarioId: ScenarioIdSchema,
    scenarioVersion: z.number().int().positive(),
    rubricVersion: z.number().int().positive(),
    manifestVersion: z.number().int().positive(),
    submittedAt: z.string(),
    report: IncidentReportSchema,
    config: z.object({
      revision: z.number().int().nonnegative(),
      configHash: z.string().regex(CONFIG_HASH_PATTERN),
      snapshot: IncidentConfigSchema,
    }),
    testRun: FrozenTestRunSchema,
    investigation: z.object({ ticketOpened: z.boolean(), runbookOpened: z.boolean(), diagnosticsOpened: z.boolean() }),
    evidence: z.object({ eventSequence: z.number().int().positive() }),
    evaluation: z.object({ status: EvaluationStatusSchema, message: z.string() }),
  })
  .refine(
    (r) => {
      const k = keys.submission(r.assignmentId, r.attemptNumber);
      if (r.PK !== k.PK || r.SK !== k.SK) return false;
      if (r.submissionId !== submissionIdFor(r.assignmentId, r.attemptNumber)) return false;
      // The frozen evidence must be internally consistent: hash <-> snapshot <-> run.
      if (r.config.configHash !== configHash(r.config.snapshot)) return false;
      const t = r.testRun;
      if (t.configHash !== r.config.configHash || t.configRevision !== r.config.revision) return false;
      if (configHash(t.configSnapshot) !== t.configHash) return false;
      const passes = t.cases.filter((c) => c.status === "PASS").length;
      if (t.passedCount !== passes || t.totalCount !== t.cases.length || t.totalCount === 0) return false;
      if (t.executor === null || t.completedAt === null) return false;
      return t.status === "PASSED" ? passes === t.totalCount : t.status === "FAILED" ? passes < t.totalCount : false;
    },
    { message: "submission is internally inconsistent" },
  );
export type SubmissionRecord = z.infer<typeof SubmissionRecordSchema>;

export function parseSubmission(item: unknown): SubmissionRecord | null {
  const parsed = SubmissionRecordSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
}

/** The terminal run exactly as it will be frozen: the view the employee had, minus live currentness flags. */
export function freezeTestRun(run: TestRunRecord): FrozenTestRun {
  return FrozenTestRunSchema.parse({
    testRunId: run.testRunId,
    status: run.status,
    configRevision: run.configRevision,
    configHash: run.configHash,
    configSnapshot: run.configSnapshot,
    suiteVersion: run.suiteVersion,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    cases: run.cases,
    passedCount: run.passedCount,
    totalCount: run.totalCount,
    executor: run.executor ? { kind: "AWS_LAMBDA", ...run.executor } : null,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
  });
}

/**
 * Build the immutable submission from AUTHORITATIVE inputs only: the engine's next
 * state, the server-held run record and the published scenario. The employee's
 * request contributes nothing here except the report text.
 */
export function buildSubmissionRecord(input: {
  next: WorkplaceState;
  scenario: PublishedScenario;
  run: TestRunRecord;
  report: IncidentReport;
  submissionId: string;
  now: string;
}): SubmissionRecord {
  const { next, scenario, run, report, submissionId, now } = input;
  return {
    ...keys.submission(next.assignmentId, next.attemptNumber),
    entityType: "SUBMISSION",
    submissionId,
    attemptNumber: next.attemptNumber,
    sessionId: next.sessionId,
    assignmentId: next.assignmentId,
    organizationId: next.organizationId,
    employeeSub: next.employeeSub,
    scenarioId: next.scenarioId,
    scenarioVersion: next.scenarioVersion,
    rubricVersion: scenario.rubricVersion,
    manifestVersion: MANIFEST_VERSION,
    submittedAt: now,
    report: { ...report },
    config: { revision: next.configRevision, configHash: next.configHash, snapshot: { ...next.config } },
    testRun: freezeTestRun(run),
    investigation: {
      ticketOpened: next.viewed.ticket,
      runbookOpened: next.viewed.runbook,
      diagnosticsOpened: next.viewed.diagnostics,
    },
    // The submission event is the last event of the evidence timeline.
    evidence: { eventSequence: next.stateVersion },
    evaluation: { ...EVALUATION_NOT_CONFIGURED },
  };
}

const DecisionRecordSchema = z
  .looseObject({
    PK: z.string(),
    SK: z.string(),
    entityType: z.literal("REVIEW_DECISION"),
    submissionId: z.string().regex(SUBMISSION_ID_PATTERN),
    assignmentId: z.string().regex(ASSIGNMENT_ID_PATTERN),
    attemptNumber: z.number().int().positive(),
    sessionId: z.string().regex(SESSION_ID_PATTERN),
    organizationId: z.string(),
    decision: ReviewDecisionSchema,
    feedback: z.string().nullable(),
    reviewerSub: UserSubSchema,
    reviewerDisplayName: z.string(),
    decidedAt: z.string(),
  })
  .refine(
    (r) => {
      const k = keys.decision(r.assignmentId, r.attemptNumber);
      return r.PK === k.PK && r.SK === k.SK && r.submissionId === submissionIdFor(r.assignmentId, r.attemptNumber);
    },
    { message: "decision keys do not match content" },
  );
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export function parseDecision(item: unknown): DecisionRecord | null {
  const parsed = DecisionRecordSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
}

export function buildDecisionRecord(input: {
  submission: SubmissionRecord;
  decision: ReviewDecision;
  feedback: string | null;
  reviewerSub: string;
  reviewerDisplayName: string;
  now: string;
}): DecisionRecord {
  const { submission: sub } = input;
  return {
    ...keys.decision(sub.assignmentId, sub.attemptNumber),
    entityType: "REVIEW_DECISION",
    submissionId: sub.submissionId,
    assignmentId: sub.assignmentId,
    attemptNumber: sub.attemptNumber,
    sessionId: sub.sessionId,
    organizationId: sub.organizationId,
    decision: input.decision,
    feedback: input.feedback,
    reviewerSub: input.reviewerSub,
    reviewerDisplayName: input.reviewerDisplayName,
    decidedAt: input.now,
  };
}

const LedgerRecordSchema = z.looseObject({
  PK: z.string(),
  SK: z.string().startsWith("IDEM#SUBMIT#"),
  entityType: z.literal("IDEMPOTENCY"),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  submissionId: z.string().regex(SUBMISSION_ID_PATTERN),
  createdAt: z.string(),
});
export type LedgerRecord = z.infer<typeof LedgerRecordSchema>;

export function parseLedger(item: unknown): LedgerRecord | null {
  const parsed = LedgerRecordSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
}

export function buildLedgerRecord(sessionId: string, key: string, requestHash: string, submissionId: string, now: string): LedgerRecord {
  return { ...keys.submitLedger(sessionId, key), entityType: "IDEMPOTENCY", requestHash, submissionId, createdAt: now };
}

/** Public review outcome (never exposes the reviewer's subject id). */
function reviewOutcome(d: DecisionRecord | undefined | null) {
  return d
    ? { decision: d.decision, feedback: d.feedback, decidedAt: d.decidedAt, reviewerDisplayName: d.reviewerDisplayName }
    : null;
}

export function toSubmissionView(sub: SubmissionRecord, decision: DecisionRecord | null | undefined): SubmissionView {
  return SubmissionViewSchema.parse({
    submissionId: sub.submissionId,
    attemptNumber: sub.attemptNumber,
    sessionId: sub.sessionId,
    assignmentId: sub.assignmentId,
    organizationId: sub.organizationId,
    scenarioId: sub.scenarioId,
    scenarioVersion: sub.scenarioVersion,
    rubricVersion: sub.rubricVersion,
    manifestVersion: sub.manifestVersion,
    submittedAt: sub.submittedAt,
    report: sub.report,
    config: sub.config,
    testRun: sub.testRun,
    investigation: sub.investigation,
    evidence: sub.evidence,
    evaluation: sub.evaluation,
    review: reviewOutcome(decision),
  });
}

export function toSubmissionSummary(sub: SubmissionRecord, decision: DecisionRecord | null | undefined): SubmissionSummary {
  return SubmissionSummarySchema.parse({
    submissionId: sub.submissionId,
    attemptNumber: sub.attemptNumber,
    submittedAt: sub.submittedAt,
    testStatus: sub.testRun.status,
    configRevision: sub.config.revision,
    review: reviewOutcome(decision),
  });
}

// ---------------------------------------------------------------------------
// Session view
// ---------------------------------------------------------------------------

/** The bounded revision, run and submission history that accompanies a session. Newest first. */
export interface SessionHistory {
  revisions: ConfigRevisionRecord[];
  runs: TestRunRecord[];
  /** Every attempt's frozen submission on this assignment. */
  submissions: SubmissionRecord[];
  decisions: DecisionRecord[];
}
export const EMPTY_HISTORY: SessionHistory = { revisions: [], runs: [], submissions: [], decisions: [] };

/** Client projection of a session. Parsing through the contract strips anything not public. */
export function toSessionView(
  state: WorkplaceState,
  scenario: PublishedScenario,
  history: SessionHistory = EMPTY_HISTORY,
): SessionView {
  const testRuns = history.runs.map((r) => toTestRunView(r, state, scenario));
  const latestCurrent = testRuns.find((r) => r.current);
  const decisionFor = (id: string) => history.decisions.find((d) => d.submissionId === id);
  const own = state.submissionId ? history.submissions.find((x) => x.submissionId === state.submissionId) : undefined;
  return SessionViewSchema.parse({
    sessionId: state.sessionId,
    assignmentId: state.assignmentId,
    organizationId: state.organizationId,
    scenarioId: state.scenarioId,
    scenarioVersion: state.scenarioVersion,
    phase: state.phase,
    stateVersion: state.stateVersion,
    config: state.config,
    configRevision: state.configRevision,
    configHash: state.configHash,
    revisions: history.revisions.map((r) =>
      ConfigRevisionViewSchema.parse({ revision: r.revision, config: r.config, configHash: r.configHash, savedAt: r.savedAt }),
    ),
    testRuns,
    currentEvidence: latestCurrent
      ? { status: latestCurrent.status, testRunId: latestCurrent.testRunId }
      : { status: "NONE", testRunId: null },
    activeTestRunId: state.activeTestRunId,
    attemptNumber: state.attemptNumber,
    submission: own ? toSubmissionView(own, decisionFor(own.submissionId)) : null,
    submissions: history.submissions.map((x) => toSubmissionSummary(x, decisionFor(x.submissionId))),
    viewed: state.viewed,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    scenario: scenario.content,
  });
}
