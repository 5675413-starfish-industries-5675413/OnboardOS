import { z } from "zod";
import { IncidentConfigSchema, ScenarioPublicSchema } from "./scenario.js";
import { ConfigRevisionViewSchema, CurrentEvidenceSchema, TestRunViewSchema } from "./testRun.js";
import { SubmissionSummarySchema, SubmissionViewSchema } from "./submission.js";

export const SessionPhaseSchema = z.enum(["NOT_STARTED", "INVESTIGATING", "SUBMITTED"]);
export type SessionPhase = z.infer<typeof SessionPhaseSchema>;

export const ViewedSchema = z.object({
  ticket: z.boolean(),
  runbook: z.boolean(),
  diagnostics: z.boolean(),
});
export type Viewed = z.infer<typeof ViewedSchema>;

/**
 * The employee-visible projection of authoritative session state.
 *
 * `stateVersion` is the optimistic-concurrency token for the next action. The
 * server owns every field; nothing here is ever accepted back from a client as
 * truth. `scenario` carries employee-visible content only (no suite ids, no
 * rubrics, no expected results).
 */
export const SessionViewSchema = z.object({
  sessionId: z.string(),
  assignmentId: z.string(),
  organizationId: z.string(),
  scenarioId: z.string(),
  scenarioVersion: z.number().int().positive(),
  phase: SessionPhaseSchema,
  stateVersion: z.number().int().nonnegative(),
  config: IncidentConfigSchema,
  /** Latest saved revision number; 0 = the scenario baseline. */
  configRevision: z.number().int().nonnegative(),
  configHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** Saved revisions, newest first (bounded). */
  revisions: z.array(ConfigRevisionViewSchema),
  /** Test runs, newest first (bounded). */
  testRuns: z.array(TestRunViewSchema),
  /** Result of the latest run for the CURRENT config, or NONE. */
  currentEvidence: CurrentEvidenceSchema,
  activeTestRunId: z.string().nullable(),
  /** 1 for the first attempt; a revision request opens attempt N+1 as a NEW session. */
  attemptNumber: z.number().int().positive(),
  /** This attempt's frozen submission (with its review outcome), or null before submitting. */
  submission: SubmissionViewSchema.nullable(),
  /** Every attempt on this assignment, newest first (read-only history). */
  submissions: z.array(SubmissionSummarySchema),
  viewed: ViewedSchema,
  startedAt: z.string().nullable(),
  updatedAt: z.string(),
  scenario: ScenarioPublicSchema,
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const StartSessionResponseSchema = z.object({
  session: SessionViewSchema,
  /** false when the session already existed (idempotent start/resume). */
  created: z.boolean(),
});
export type StartSessionResponse = z.infer<typeof StartSessionResponseSchema>;

/**
 * Semantic actions a client may request. Starting the investigation is not
 * here: it happens only through POST /v1/assignments/:id/start.
 */
export const ClientActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("OPEN_TICKET"), ticketId: z.string().min(1).max(64) }),
  z.strictObject({ type: z.literal("OPEN_RUNBOOK"), runbookId: z.string().min(1).max(64) }),
  z.strictObject({ type: z.literal("OPEN_DIAGNOSTICS"), diagnosticsId: z.string().min(1).max(64) }),
]);
export type ClientAction = z.infer<typeof ClientActionSchema>;

/** STRICT: a client cannot smuggle in `phase`, `passed`, `status`, `role`, etc. */
export const SessionActionRequestSchema = z.strictObject({
  expectedStateVersion: z.number().int().nonnegative(),
  action: ClientActionSchema,
});
export type SessionActionRequest = z.infer<typeof SessionActionRequestSchema>;

export const SessionActionResponseSchema = z.object({ session: SessionViewSchema });
export type SessionActionResponse = z.infer<typeof SessionActionResponseSchema>;

export const GetSessionResponseSchema = z.object({ session: SessionViewSchema });
export type GetSessionResponse = z.infer<typeof GetSessionResponseSchema>;

export const SaveConfigResponseSchema = z.object({ session: SessionViewSchema });
export type SaveConfigResponse = z.infer<typeof SaveConfigResponseSchema>;

/** Returned when a run is requested and when it is polled. */
export const TestRunResponseSchema = z.object({ testRun: TestRunViewSchema, session: SessionViewSchema });
export type TestRunResponse = z.infer<typeof TestRunResponseSchema>;

export const SubmitReportResponseSchema = z.object({
  submission: SubmissionViewSchema,
  session: SessionViewSchema,
  /** false when an identical retry (same Idempotency-Key and content) returned the original. */
  created: z.boolean(),
});
export type SubmitReportResponse = z.infer<typeof SubmitReportResponseSchema>;
