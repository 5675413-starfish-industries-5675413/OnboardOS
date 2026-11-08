/**
 * Client for the dedicated scenario-runner Lambda, and strict validation of
 * everything it returns.
 *
 * There is NO in-process or simulated fallback here: if the runner cannot be
 * invoked the run is recorded as ERROR. Tests inject a client that calls the real
 * runner handler; production code never imports the runner package or any suite.
 */

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  RunnerResponseSchema,
  type RunnerRequest,
} from "@onboardos/scenario-engine";
import type { RunErrorCode, RunOutcome } from "./records.js";

/** What a runner invocation produced, before any validation. */
export interface RunnerInvocation {
  /** Parsed JSON payload (untrusted), or undefined if there was none. */
  payload: unknown;
  /** Lambda's FunctionError marker ("Handled"/"Unhandled"), or null. */
  functionError: string | null;
  /** The request id AWS returned to the caller; null if unavailable. */
  invokeRequestId: string | null;
}

/** Thrown by a RunnerClient when the invocation itself failed (not when the runner reported failures). */
export class RunnerInvokeError extends Error {
  readonly code: "RUNNER_INVOCATION_FAILED" | "RUNNER_TIMEOUT" | "RUNNER_BAD_RESPONSE";
  constructor(code: RunnerInvokeError["code"]) {
    super(code);
    this.name = "RunnerInvokeError";
    this.code = code;
  }
}

export interface RunnerClient {
  invoke(request: RunnerRequest): Promise<RunnerInvocation>;
}

/** Bounded: the runner's own timeout is 10 s and the API function's is 29 s. */
export const RUNNER_CALL_TIMEOUT_MS = 15_000;

export class LambdaRunnerClient implements RunnerClient {
  constructor(
    private readonly lambda: Pick<LambdaClient, "send">,
    private readonly functionName: string,
    private readonly timeoutMs: number = RUNNER_CALL_TIMEOUT_MS,
  ) {}

  async invoke(request: RunnerRequest): Promise<RunnerInvocation> {
    let res;
    try {
      res = await this.lambda.send(
        new InvokeCommand({
          FunctionName: this.functionName,
          InvocationType: "RequestResponse",
          LogType: "None",
          Payload: Buffer.from(JSON.stringify(request), "utf8"),
        }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (err) {
      const name = typeof err === "object" && err !== null ? String((err as { name?: unknown }).name) : "";
      throw new RunnerInvokeError(name === "TimeoutError" || name === "AbortError" ? "RUNNER_TIMEOUT" : "RUNNER_INVOCATION_FAILED");
    }
    if (res.StatusCode !== 200) throw new RunnerInvokeError("RUNNER_INVOCATION_FAILED");

    let payload: unknown;
    if (res.Payload && res.Payload.length > 0) {
      try {
        payload = JSON.parse(Buffer.from(res.Payload).toString("utf8"));
      } catch {
        // A FunctionError payload is also JSON, but be strict: unparseable is unusable.
        throw new RunnerInvokeError("RUNNER_BAD_RESPONSE");
      }
    }
    return {
      payload,
      functionError: res.FunctionError ?? null,
      invokeRequestId: res.$metadata?.requestId ?? null,
    };
  }
}

let cachedLambda: LambdaClient | undefined;

/** Production client. Throws if the function name is not configured (=> 500 before any state is written). */
export function lambdaRunnerFromEnv(): RunnerClient {
  const name = process.env["ONBOARDOS_RUNNER_FUNCTION_NAME"];
  if (!name) throw new Error("ONBOARDOS_RUNNER_FUNCTION_NAME must be set");
  cachedLambda ??= new LambdaClient({ maxAttempts: 2 });
  return new LambdaRunnerClient(cachedLambda, name);
}

const error = (errorCode: RunErrorCode): RunOutcome => ({ kind: "ERROR", errorCode });

/**
 * Turn a raw invocation into a trusted outcome, or an ERROR. The runner's
 * response is never believed on its own: it must match the schema, echo exactly
 * what was sent, and have a status that agrees with its own cases.
 */
export function evaluateRunnerResult(sent: RunnerRequest, inv: RunnerInvocation): RunOutcome {
  if (inv.functionError !== null) return error("RUNNER_FUNCTION_ERROR");

  const parsed = RunnerResponseSchema.safeParse(inv.payload);
  if (!parsed.success) return error("RUNNER_BAD_RESPONSE");
  const res = parsed.data;

  if (res.testRunId !== sent.testRunId) return error("RUNNER_MISMATCH");
  if (!res.ok) return error("RUNNER_REJECTED");

  if (res.suiteId !== sent.suiteId || res.suiteVersion !== sent.suiteVersion || res.configHash !== sent.configHash) {
    return error("RUNNER_MISMATCH");
  }

  const ids = new Set(res.cases.map((c) => c.caseId));
  if (ids.size !== res.cases.length) return error("RUNNER_BAD_RESPONSE");
  const allPass = res.cases.every((c) => c.status === "PASS");
  if ((res.status === "PASSED") !== allPass) return error("RUNNER_BAD_RESPONSE");

  return {
    kind: "COMPLETED",
    status: res.status,
    cases: res.cases,
    executor: { region: res.executor.region, runnerRequestId: res.executor.requestId, invokeRequestId: inv.invokeRequestId },
  };
}

/** Invoke and evaluate; every failure becomes a recorded ERROR outcome. Never throws for runner problems. */
export async function executeRun(client: RunnerClient, sent: RunnerRequest): Promise<RunOutcome> {
  try {
    return evaluateRunnerResult(sent, await client.invoke(sent));
  } catch (err) {
    if (err instanceof RunnerInvokeError) return error(err.code);
    return error("RUNNER_INVOCATION_FAILED");
  }
}
