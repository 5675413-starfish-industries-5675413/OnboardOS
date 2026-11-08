import { z } from "zod";
import { IncidentConfigSchema } from "./scenario.js";

/**
 * Config revisions and test runs, as shown to the assigned employee.
 *
 * SECURITY BOUNDARY: a test run exposes per-case NAMES, PASS/FAIL and a short
 * message only. Hidden inputs, expected values, thresholds, the suite id, the
 * runner function name/ARN and AWS credentials never appear here.
 */

const ConfigHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const ConfigRevisionViewSchema = z.object({
  /** 1-based. Revision 0 (the scenario baseline) is not a stored revision. */
  revision: z.number().int().positive(),
  config: IncidentConfigSchema,
  configHash: ConfigHashSchema,
  savedAt: z.string(),
});
export type ConfigRevisionView = z.infer<typeof ConfigRevisionViewSchema>;

export const TestCaseResultSchema = z.object({
  caseId: z.string(),
  name: z.string(),
  status: z.enum(["PASS", "FAIL"]),
  message: z.string(),
});
export type TestCaseResult = z.infer<typeof TestCaseResultSchema>;

/** RUNNING is reserved; the backend persists PENDING then a terminal status. */
export const TestRunStatusSchema = z.enum(["PENDING", "RUNNING", "PASSED", "FAILED", "ERROR"]);
export type TestRunStatus = z.infer<typeof TestRunStatusSchema>;

/** Evidence that the cases ran in the dedicated AWS Lambda runner (not synthetic). */
export const TestRunExecutorSchema = z.object({
  kind: z.literal("AWS_LAMBDA"),
  region: z.string(),
  /** The runner's own AWS request id (from its Lambda context). */
  runnerRequestId: z.string(),
  /** The request id AWS returned to the invoking API; null if unavailable. */
  invokeRequestId: z.string().nullable(),
});
export type TestRunExecutor = z.infer<typeof TestRunExecutorSchema>;

export const TestRunViewSchema = z.object({
  testRunId: z.string(),
  status: TestRunStatusSchema,
  /** The exact revision, snapshot and hash this run executed against. */
  configRevision: z.number().int().nonnegative(),
  configHash: ConfigHashSchema,
  configSnapshot: IncidentConfigSchema,
  suiteVersion: z.number().int().positive(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  cases: z.array(TestCaseResultSchema),
  passedCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  executor: TestRunExecutorSchema.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** Derived at read time: same revision, hash and suite version as the session now. */
  current: z.boolean(),
  /** Derived at read time: finished, but for configuration that is no longer current. */
  stale: z.boolean(),
});
export type TestRunView = z.infer<typeof TestRunViewSchema>;

export const CurrentEvidenceSchema = z.object({
  status: z.enum(["NONE", "PENDING", "PASSED", "FAILED", "ERROR"]),
  testRunId: z.string().nullable(),
});
export type CurrentEvidence = z.infer<typeof CurrentEvidenceSchema>;

/** STRICT: the client sends only the config and the version it was based on. */
export const SaveConfigRequestSchema = z.strictObject({
  expectedStateVersion: z.number().int().nonnegative(),
  config: IncidentConfigSchema,
});
export type SaveConfigRequest = z.infer<typeof SaveConfigRequestSchema>;

/**
 * STRICT: the server tests the CURRENT revision. The client never supplies a
 * revision, hash, suite, expectation or result.
 */
export const RunTestsRequestSchema = z.strictObject({
  expectedStateVersion: z.number().int().nonnegative(),
});
export type RunTestsRequest = z.infer<typeof RunTestsRequestSchema>;
