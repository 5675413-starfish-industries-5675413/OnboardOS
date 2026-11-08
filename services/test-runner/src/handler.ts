/**
 * Scenario runner Lambda handler.
 *
 * Private: no HTTP event source; invoked only by the API function through the
 * Lambda Invoke API. Pure computation over the request: no DynamoDB, no network,
 * no environment-supplied secrets, and NO execution of caller-supplied code.
 * It trusts nothing in the request: it validates the snapshot and recomputes the
 * hash itself.
 */
import {
  RunnerRequestSchema,
  configHash,
  validateConfig,
  type RunnerResponse,
} from "@onboardos/scenario-engine";
import {
  INC104_SCENARIO_ID,
  INC104_SCENARIO_VERSION,
  INC104_SUITE_ID,
  INC104_SUITE_VERSION,
  runInc104Suite,
} from "./suites/inc104.js";

export interface RunnerContext {
  readonly awsRequestId: string;
}

export async function runnerHandler(event: unknown, context: RunnerContext): Promise<RunnerResponse> {
  const parsed = RunnerRequestSchema.safeParse(event);
  if (!parsed.success) {
    // Malformed protocol request: surface as a function error (the API maps it to ERROR).
    throw new Error("INVALID_RUNNER_REQUEST");
  }
  const req = parsed.data;
  const log = (status: string, passed: number, total: number): void => {
    console.log(JSON.stringify({
      event: "scenario_run", testRunId: req.testRunId, suiteId: req.suiteId, suiteVersion: req.suiteVersion,
      configHash: req.configHash, status, passed, total, requestId: context.awsRequestId,
    }));
  };

  // All four identifiers must match: the suite is only valid for this scenario version.
  if (
    req.scenarioId !== INC104_SCENARIO_ID ||
    req.scenarioVersion !== INC104_SCENARIO_VERSION ||
    req.suiteId !== INC104_SUITE_ID ||
    req.suiteVersion !== INC104_SUITE_VERSION
  ) {
    log("UNKNOWN_SUITE", 0, 0);
    return { ok: false, testRunId: req.testRunId, errorCode: "UNKNOWN_SUITE" };
  }

  const snapshot = validateConfig(req.configSnapshot);
  if (!snapshot.ok) {
    log("INVALID_SNAPSHOT", 0, 0);
    return { ok: false, testRunId: req.testRunId, errorCode: "INVALID_SNAPSHOT" };
  }

  // Independent recomputation: the runner never takes the claimed hash on faith.
  if (configHash(snapshot.config) !== req.configHash) {
    log("HASH_MISMATCH", 0, 0);
    return { ok: false, testRunId: req.testRunId, errorCode: "HASH_MISMATCH" };
  }

  const cases = runInc104Suite(snapshot.config, true);
  const passed = cases.filter((c) => c.status === "PASS").length;
  const status = passed === cases.length ? "PASSED" : "FAILED";
  log(status, passed, cases.length);

  return {
    ok: true,
    testRunId: req.testRunId,
    suiteId: req.suiteId,
    suiteVersion: req.suiteVersion,
    configHash: req.configHash,
    status,
    cases,
    executor: { requestId: context.awsRequestId, region: process.env.AWS_REGION ?? "unknown" },
  };
}
