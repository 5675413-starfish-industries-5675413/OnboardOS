import { z } from "zod";
import { IncidentConfigSchema } from "./scenario.js";
import { TestRunViewSchema } from "./testRun.js";

/**
 * Incident submissions and manager review (ONB-10).
 *
 * SECURITY BOUNDARY: a submission is a FROZEN, server-built copy of evidence the
 * server already held. Nothing in a submission request is authority: ids,
 * hashes and run references a client sends are only assertions the server
 * compares with its own records. No hidden suite content or thresholds are
 * representable here (the same view of a test run the employee already had).
 */

/** Bounded text: long enough to be a real answer, short enough to store as a small item. */
export const REPORT_FIELD_MIN = 10;
export const REPORT_FIELD_MAX = 1500;
export const FEEDBACK_MIN = 10;
export const FEEDBACK_MAX = 1500;
/** Revision requests stop at this many attempts (bounds storage and the review loop). */
export const MAX_ATTEMPTS = 5;

const ReportField = z.string().trim().min(REPORT_FIELD_MIN).max(REPORT_FIELD_MAX);

export const IncidentReportSchema = z.strictObject({
  rootCause: ReportField,
  correctiveAction: ReportField,
  verification: ReportField,
  remainingRisks: ReportField,
});
export type IncidentReport = z.infer<typeof IncidentReportSchema>;

const ConfigHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const TestRunId = z.string().regex(/^run_\d{4}_[0-9a-f]{12}$/);
export const SubmissionIdSchema = z.string().regex(/^sub_\d{2}_[0-9a-f]{32}$/);

/**
 * STRICT. `testRunId`, `configRevision` and `configHash` are the employee's
 * ASSERTION of what they are submitting. The server derives the real current
 * evidence itself and rejects any difference (stale, forged or cross-session).
 */
export const SubmitReportRequestSchema = z.strictObject({
  expectedStateVersion: z.number().int().nonnegative(),
  testRunId: TestRunId,
  configRevision: z.number().int().nonnegative(),
  configHash: ConfigHash,
  report: IncidentReportSchema,
});
export type SubmitReportRequest = z.infer<typeof SubmitReportRequestSchema>;

export const ReviewDecisionSchema = z.enum(["APPROVE", "REQUEST_REVISION"]);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

/** STRICT. REQUEST_REVISION must carry actionable feedback; APPROVE may carry an optional note. */
export const ReviewDecisionRequestSchema = z
  .strictObject({
    decision: ReviewDecisionSchema,
    feedback: z.string().trim().max(FEEDBACK_MAX).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "REQUEST_REVISION" && (v.feedback ?? "").length < FEEDBACK_MIN) {
      ctx.addIssue({
        code: "custom",
        path: ["feedback"],
        message: `Feedback of at least ${FEEDBACK_MIN} characters is required when requesting a revision`,
      });
    }
  });
export type ReviewDecisionRequest = z.infer<typeof ReviewDecisionRequestSchema>;

/**
 * AI assessment is not part of this slice. `NOT_CONFIGURED` is an explicit,
 * honest state (never a fake "evaluated"); PENDING/COMPLETE/ERROR are reserved
 * so the contract does not change when Bedrock evaluation lands.
 */
export const EvaluationStatusSchema = z.enum(["NOT_CONFIGURED", "PENDING", "COMPLETE", "ERROR"]);
export type EvaluationStatus = z.infer<typeof EvaluationStatusSchema>;

export const ReviewOutcomeViewSchema = z.object({
  decision: ReviewDecisionSchema,
  feedback: z.string().nullable(),
  decidedAt: z.string(),
  reviewerDisplayName: z.string(),
});
export type ReviewOutcomeView = z.infer<typeof ReviewOutcomeViewSchema>;

/** The execution evidence exactly as it was when frozen: a run view without live currentness flags. */
export const FrozenTestRunSchema = TestRunViewSchema.omit({ current: true, stale: true });
export type FrozenTestRun = z.infer<typeof FrozenTestRunSchema>;

export const SubmissionViewSchema = z.object({
  submissionId: SubmissionIdSchema,
  attemptNumber: z.number().int().positive(),
  sessionId: z.string(),
  assignmentId: z.string(),
  organizationId: z.string(),
  scenarioId: z.string(),
  scenarioVersion: z.number().int().positive(),
  rubricVersion: z.number().int().positive(),
  manifestVersion: z.number().int().positive(),
  submittedAt: z.string(),
  report: IncidentReportSchema,
  config: z.object({
    revision: z.number().int().nonnegative(),
    configHash: ConfigHash,
    snapshot: IncidentConfigSchema,
  }),
  /** The terminal PASSED or FAILED run this submission is bound to. A FAILED run is honest evidence, not a resolution. */
  testRun: FrozenTestRunSchema,
  investigation: z.object({
    ticketOpened: z.boolean(),
    runbookOpened: z.boolean(),
    diagnosticsOpened: z.boolean(),
  }),
  evidence: z.object({
    /** The evidence timeline for this submission ends at this event sequence. */
    eventSequence: z.number().int().positive(),
  }),
  evaluation: z.object({ status: EvaluationStatusSchema, message: z.string() }),
  /** Present once a manager has decided; null while awaiting review. */
  review: ReviewOutcomeViewSchema.nullable(),
});
export type SubmissionView = z.infer<typeof SubmissionViewSchema>;

/** One line per attempt, for history lists. */
export const SubmissionSummarySchema = z.object({
  submissionId: SubmissionIdSchema,
  attemptNumber: z.number().int().positive(),
  submittedAt: z.string(),
  testStatus: z.enum(["PASSED", "FAILED"]),
  configRevision: z.number().int().nonnegative(),
  review: ReviewOutcomeViewSchema.nullable(),
});
export type SubmissionSummary = z.infer<typeof SubmissionSummarySchema>;
