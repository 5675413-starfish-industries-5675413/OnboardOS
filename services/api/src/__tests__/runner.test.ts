import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { InvokeCommand } from "@aws-sdk/client-lambda";
import { describe, expect, it, vi } from "vitest";
import type { RunnerRequest } from "@onboardos/scenario-engine";
import { LambdaRunnerClient, RunnerInvokeError, lambdaRunnerFromEnv } from "../runner.js";

const REQ: RunnerRequest = {
  testRunId: "run_0001_aaaaaaaaaaaa",
  scenarioId: "inc-104",
  scenarioVersion: 1,
  suiteId: "inc-104-checkout-timeout",
  suiteVersion: 1,
  configSnapshot: { request_timeout_ms: 1800 },
  configHash: "sha256:" + "a".repeat(64),
};

function fakeLambda(result: unknown) {
  const send = vi.fn(async (_cmd: unknown, _opts?: unknown) => {
    if (result instanceof Error) throw result;
    return result as never;
  });
  return { send } as unknown as { send: typeof send };
}
const named = (name: string) => Object.assign(new Error("x"), { name });
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe("LambdaRunnerClient (the real production client, with a fake Lambda SDK client)", () => {
  it("invokes the configured function synchronously with the request as JSON, no log tail, bounded by an abort signal", async () => {
    const lambda = fakeLambda({ StatusCode: 200, Payload: bytes({ ok: true }), $metadata: { requestId: "aws-req-1" } });
    const out = await new LambdaRunnerClient(lambda, "my-runner-fn").invoke(REQ);

    expect(lambda.send).toHaveBeenCalledTimes(1);
    const [cmd, opts] = lambda.send.mock.calls[0]!;
    expect(cmd).toBeInstanceOf(InvokeCommand);
    const input = (cmd as InvokeCommand).input;
    expect(input).toMatchObject({ FunctionName: "my-runner-fn", InvocationType: "RequestResponse", LogType: "None" });
    expect(JSON.parse(Buffer.from(input.Payload as Uint8Array).toString("utf8"))).toEqual(REQ);
    expect((opts as { abortSignal: AbortSignal }).abortSignal).toBeInstanceOf(AbortSignal);
    expect(out).toEqual({ payload: { ok: true }, functionError: null, invokeRequestId: "aws-req-1" });
  });

  it("reports FunctionError and tolerates a missing request id", async () => {
    const lambda = fakeLambda({ StatusCode: 200, FunctionError: "Unhandled", Payload: bytes({ errorMessage: "boom" }), $metadata: {} });
    const out = await new LambdaRunnerClient(lambda, "f").invoke(REQ);
    expect(out).toMatchObject({ functionError: "Unhandled", invokeRequestId: null });
  });

  it.each([["TimeoutError"], ["AbortError"]])("maps %s to RUNNER_TIMEOUT", async (name) => {
    await expect(new LambdaRunnerClient(fakeLambda(named(name)), "f").invoke(REQ)).rejects.toMatchObject({ code: "RUNNER_TIMEOUT" });
  });

  it.each([["AccessDeniedException"], ["ResourceNotFoundException"], ["TooManyRequestsException"]])(
    "maps %s to RUNNER_INVOCATION_FAILED without exposing the SDK error",
    async (name) => {
      const err = await new LambdaRunnerClient(fakeLambda(named(name)), "f").invoke(REQ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RunnerInvokeError);
      expect(err).toMatchObject({ code: "RUNNER_INVOCATION_FAILED", message: "RUNNER_INVOCATION_FAILED" });
    },
  );

  it("treats a non-200 status as a failed invocation", async () => {
    await expect(new LambdaRunnerClient(fakeLambda({ StatusCode: 202, $metadata: {} }), "f").invoke(REQ)).rejects.toMatchObject({
      code: "RUNNER_INVOCATION_FAILED",
    });
  });

  it("treats an unparseable payload as a bad response", async () => {
    const lambda = fakeLambda({ StatusCode: 200, Payload: new TextEncoder().encode("not json{"), $metadata: {} });
    await expect(new LambdaRunnerClient(lambda, "f").invoke(REQ)).rejects.toMatchObject({ code: "RUNNER_BAD_RESPONSE" });
  });

  it("an empty payload yields undefined (later rejected as a bad response by validation)", async () => {
    const out = await new LambdaRunnerClient(fakeLambda({ StatusCode: 200, $metadata: {} }), "f").invoke(REQ);
    expect(out.payload).toBeUndefined();
  });
});

describe("lambdaRunnerFromEnv", () => {
  it("fails closed when the runner function name is not configured", () => {
    const saved = process.env["ONBOARDOS_RUNNER_FUNCTION_NAME"];
    delete process.env["ONBOARDOS_RUNNER_FUNCTION_NAME"];
    try {
      expect(() => lambdaRunnerFromEnv()).toThrow(/ONBOARDOS_RUNNER_FUNCTION_NAME/);
      process.env["ONBOARDOS_RUNNER_FUNCTION_NAME"] = "some-fn";
      expect(() => lambdaRunnerFromEnv()).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env["ONBOARDOS_RUNNER_FUNCTION_NAME"];
      else process.env["ONBOARDOS_RUNNER_FUNCTION_NAME"] = saved;
    }
  });
});

describe("API source boundary: the API never contains the hidden suite", () => {
  const SRC = join(__dirname, "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return n === "__tests__" ? [] : files(p);
      return /\.ts$/.test(n) ? [p] : [];
    });
  const FILES = files(SRC);

  it("scans a meaningful number of files", () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it("non-test API code never imports the runner package or any suite", () => {
    for (const f of FILES) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/@onboardos\/test-runner|services\/test-runner|suites\/inc104/);
      expect(text, f).not.toMatch(/latency-profile|PROFILE_[AB]_UPSTREAM|runInc104Suite/);
    }
  });

  it("only test code in the API imports the runner (to execute the real handler in-process)", () => {
    const harness = readFileSync(join(SRC, "__tests__", "harness.ts"), "utf8");
    expect(harness).toContain("@onboardos/test-runner");
  });
});
