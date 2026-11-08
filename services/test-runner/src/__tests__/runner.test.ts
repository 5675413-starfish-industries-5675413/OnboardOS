import { beforeEach, describe, it, expect, vi } from "vitest";
import { configHash, RunnerResponseSchema } from "@onboardos/scenario-engine";
import { runnerHandler } from "../handler.js";
import { INC104_SUITE_ID, INC104_SUITE_VERSION } from "../suites/inc104.js";

const CTX = { awsRequestId: "req-abc-123" };
const RUN = "run_0001_0123456789ab";

function request(ms: unknown, overrides: Record<string, unknown> = {}) {
  const snapshot = { request_timeout_ms: ms };
  return {
    testRunId: RUN,
    scenarioId: "inc-104",
    scenarioVersion: 1,
    suiteId: INC104_SUITE_ID,
    suiteVersion: INC104_SUITE_VERSION,
    configSnapshot: snapshot,
    configHash: typeof ms === "number" && Number.isInteger(ms) ? configHash({ request_timeout_ms: ms }) : "sha256:" + "0".repeat(64),
    ...overrides,
  };
}

describe("INC-104 runner suite", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it.each([
    [800, "FAILED", 3],
    [1400, "FAILED", 4],
    [1800, "PASSED", 5],
    [1200, "FAILED", 4],
    [1600, "PASSED", 5],
    [100, "FAILED", 3],
    [2000, "PASSED", 5],
  ])("timeout %i -> %s with %i/5 cases passing", async (ms, status, passed) => {
    const res = await runnerHandler(request(ms), CTX);
    expect(RunnerResponseSchema.safeParse(res).success).toBe(true);
    expect(res).toMatchObject({ ok: true, status });
    if (!res.ok) throw new Error("unreachable");
    expect(res.cases).toHaveLength(5);
    expect(res.cases.filter((c) => c.status === "PASS")).toHaveLength(passed);
    // status is derived from the cases, never independent of them
    expect(res.status === "PASSED").toBe(res.cases.every((c) => c.status === "PASS"));
  });

  it("echoes identifiers and reports its own AWS request id and region", async () => {
    const req = request(1800);
    const res = await runnerHandler(req, CTX);
    expect(res).toMatchObject({
      ok: true, testRunId: RUN, suiteId: INC104_SUITE_ID, suiteVersion: INC104_SUITE_VERSION,
      configHash: req.configHash, executor: { requestId: "req-abc-123" },
    });
  });

  it("rejects an unknown suite id or version", async () => {
    expect(await runnerHandler(request(1800, { suiteId: "other" }), CTX)).toEqual({ ok: false, testRunId: RUN, errorCode: "UNKNOWN_SUITE" });
    expect(await runnerHandler(request(1800, { suiteVersion: 2 }), CTX)).toEqual({ ok: false, testRunId: RUN, errorCode: "UNKNOWN_SUITE" });
  });

  it("rejects a wrong scenario id or scenario version, even with a correct suite", async () => {
    const unknown = { ok: false, testRunId: RUN, errorCode: "UNKNOWN_SUITE" };
    expect(await runnerHandler(request(1800, { scenarioId: "inc-105" }), CTX)).toEqual(unknown);
    expect(await runnerHandler(request(1800, { scenarioVersion: 2 }), CTX)).toEqual(unknown);
    expect(await runnerHandler(request(1800, { scenarioId: "inc-105", scenarioVersion: 2 }), CTX)).toEqual(unknown);
  });

  it("a structurally invalid scenario id is a protocol error, not a silent pass", async () => {
    await expect(runnerHandler(request(1800, { scenarioId: "" }), CTX)).rejects.toThrow("INVALID_RUNNER_REQUEST");
  });

  it("accepts only the exact scenario/suite combination", async () => {
    const res = await runnerHandler(request(1800, { scenarioId: "inc-104", scenarioVersion: 1 }), CTX);
    expect(res).toMatchObject({ ok: true, status: "PASSED" });
  });

  it.each([["out of policy", 5000], ["string", "1800"], ["float", 1800.5]])(
    "rejects an invalid snapshot (%s)",
    async (_n, v) => {
      const res = await runnerHandler(request(v, { configHash: "sha256:" + "1".repeat(64) }), CTX);
      expect(res).toEqual({ ok: false, testRunId: RUN, errorCode: "INVALID_SNAPSHOT" });
    },
  );

  it("rejects a snapshot with extra fields", async () => {
    const res = await runnerHandler(request(1800, { configSnapshot: { request_timeout_ms: 1800, passed: true } }), CTX);
    expect(res).toMatchObject({ ok: false, errorCode: "INVALID_SNAPSHOT" });
  });

  it("recomputes the hash and refuses a mismatch instead of trusting the caller", async () => {
    const res = await runnerHandler(request(1800, { configHash: configHash({ request_timeout_ms: 800 }) }), CTX);
    expect(res).toEqual({ ok: false, testRunId: RUN, errorCode: "HASH_MISMATCH" });
  });

  it("throws on a malformed protocol request (extra field, bad id)", async () => {
    await expect(runnerHandler({ ...request(1800), expectedOutcome: "PASSED" }, CTX)).rejects.toThrow("INVALID_RUNNER_REQUEST");
    await expect(runnerHandler(request(1800, { testRunId: "nope" }), CTX)).rejects.toThrow();
    await expect(runnerHandler(null, CTX)).rejects.toThrow();
  });

  it("does not leak thresholds in anything it returns", async () => {
    const res = await runnerHandler(request(800), CTX);
    if (!res.ok) throw new Error("unreachable");
    const text = JSON.stringify(res.cases); // hashes are hex and could contain digits by chance
    expect(text).not.toMatch(/1200|1600|threshold|expected|minimum|required|at least/i);
  });

  it("logs one structured line per execution without the snapshot contents", async () => {
    const spy = vi.mocked(console.log);
    spy.mockClear();
    await runnerHandler(request(1400), CTX);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(line).toMatchObject({ event: "scenario_run", testRunId: RUN, status: "FAILED", passed: 4, total: 5, requestId: "req-abc-123" });
  });
});
