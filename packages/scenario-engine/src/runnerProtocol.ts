/**
 * The frozen request/response protocol between the API and the dedicated
 * scenario-runner Lambda (freeze doc, section H).
 *
 * SERVER-ONLY: this module lives in the engine, which the browser never
 * imports. The API validates every runner response against these schemas and
 * never trusts the runner's echo without comparing it to what it sent.
 */
import { z } from "zod";
import { CONFIG_HASH_PATTERN } from "./config.js";

export const RUNNER_MAX_CASES = 20;

export const TEST_RUN_ID_PATTERN = /^run_\d{4}_[0-9a-f]{12}$/;

export const RunnerRequestSchema = z.strictObject({
  testRunId: z.string().regex(TEST_RUN_ID_PATTERN),
  scenarioId: z.string().min(1).max(64),
  scenarioVersion: z.number().int().positive(),
  suiteId: z.string().min(1).max(64),
  suiteVersion: z.number().int().positive(),
  /** UNTRUSTED from the runner's point of view; it validates and re-hashes it. */
  configSnapshot: z.unknown(),
  configHash: z.string().regex(CONFIG_HASH_PATTERN),
});
export type RunnerRequest = z.infer<typeof RunnerRequestSchema>;

export const RunnerCaseSchema = z.strictObject({
  caseId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(120),
  status: z.enum(["PASS", "FAIL"]),
  message: z.string().max(240),
});
export type RunnerCase = z.infer<typeof RunnerCaseSchema>;

export const RunnerFailureCodeSchema = z.enum(["UNKNOWN_SUITE", "INVALID_SNAPSHOT", "HASH_MISMATCH"]);
export type RunnerFailureCode = z.infer<typeof RunnerFailureCodeSchema>;

export const RunnerResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    testRunId: z.string().regex(TEST_RUN_ID_PATTERN),
    suiteId: z.string().min(1).max(64),
    suiteVersion: z.number().int().positive(),
    configHash: z.string().regex(CONFIG_HASH_PATTERN),
    status: z.enum(["PASSED", "FAILED"]),
    cases: z.array(RunnerCaseSchema).min(1).max(RUNNER_MAX_CASES),
    executor: z.strictObject({
      requestId: z.string().min(1).max(128),
      region: z.string().min(1).max(32),
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    testRunId: z.string().regex(TEST_RUN_ID_PATTERN),
    errorCode: RunnerFailureCodeSchema,
  }),
]);
export type RunnerResponse = z.infer<typeof RunnerResponseSchema>;
