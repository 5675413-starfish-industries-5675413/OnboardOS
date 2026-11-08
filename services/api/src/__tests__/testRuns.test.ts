/**
 * Phase 2C: immutable config revisions and genuine runner-backed test runs.
 *
 * The REAL router, routes, authorization, engine and the REAL runner handler run
 * here against an in-memory DynamoDB. The only substitution is the network hop to
 * Lambda (see harness.inProcessRunner). Nothing here proves behaviour of the
 * deployed Lambda or IAM; that is verified separately against AWS.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configHash } from "@onboardos/scenario-engine";
import { RunnerInvokeError, type RunnerClient } from "../runner.js";
import { SESSION_ID_PATTERN } from "../ids.js";
import {
  CORE,
  EVENTS,
  PEOPLE,
  R,
  assign,
  createApi,
  getRun,
  inProcessRunner,
  runTests,
  saveConfig,
  startAs,
  startedSession,
  type Api,
} from "./harness.js";

let api: Api;
let sessionId: string;

const stateKey = (id = sessionId) => ({ PK: `SESSION#${id}`, SK: "STATE" });
const storedState = (id = sessionId) => api.db.get(CORE, stateKey(id))!;
const items = (prefix: string, id = sessionId) =>
  api.db.all(CORE).filter((i) => i["PK"] === `SESSION#${id}` && String(i["SK"]).startsWith(prefix));
const events = (id = sessionId) =>
  api.db.all(EVENTS).filter((e) => e["PK"] === `SESSION#${id}`).sort((a, b) => String(a["SK"]).localeCompare(String(b["SK"])));
const version = () => storedState()["stateVersion"] as number;

/** Save `ms` then run, returning both responses. Uses the stored version so tests stay readable. */
async function saveThenRun(ms: number) {
  const saved = await saveConfig(api, PEOPLE.empA, sessionId, version(), ms);
  expect(saved.status).toBe(200);
  const run = await runTests(api, PEOPLE.empA, sessionId, version());
  return { saved, run };
}

const okPayload = (req: any, over: Record<string, unknown> = {}) => ({
  ok: true,
  testRunId: req.testRunId,
  suiteId: req.suiteId,
  suiteVersion: req.suiteVersion,
  configHash: req.configHash,
  status: "PASSED",
  cases: [{ caseId: "c-1", name: "n", status: "PASS", message: "m" }],
  executor: { requestId: "x-1", region: "us-east-1" },
  ...over,
});
const returning = (fn: (req: any) => unknown, functionError: string | null = null): RunnerClient => ({
  invoke: async (req) => ({ payload: fn(req), functionError, invokeRequestId: "inv-1" }),
});
const throwing = (err: unknown): RunnerClient => ({ invoke: async () => { throw err; } });

function gatedRunner() {
  const inner = inProcessRunner();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const client: RunnerClient = { invoke: async (req) => { await gate; return inner.invoke(req); } };
  return { client, release };
}

beforeEach(async () => {
  api = createApi();
  ({ sessionId } = await startedSession(api));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------

describe("saving configuration revisions", () => {
  it("creates numbered revision 1 with a server-computed hash, a state bump and an event, atomically", async () => {
    const res = await saveConfig(api, PEOPLE.empA, sessionId, 1, 1800);
    expect(res.status).toBe(200);
    const s = res.body.session;
    expect(s).toMatchObject({ stateVersion: 2, configRevision: 1, config: { request_timeout_ms: 1800 } });
    expect(s.configHash).toBe(configHash({ request_timeout_ms: 1800 }));
    expect(s.revisions).toHaveLength(1);
    expect(s.revisions[0]).toMatchObject({ revision: 1, config: { request_timeout_ms: 1800 }, configHash: s.configHash });

    const rev = items("CONFIG#");
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ SK: "CONFIG#0000000001", revision: 1, savedBySub: PEOPLE.empA.sub, stateVersion: 2 });
    const evs = events();
    expect(evs.map((e) => e["type"])).toEqual(["INVESTIGATION_STARTED", "CONFIG_SAVED"]);
    expect(evs[1]).toMatchObject({ stateVersion: 2, actorSub: PEOPLE.empA.sub });
  });

  it("numbers revisions consecutively and keeps every earlier revision unchanged", async () => {
    await saveConfig(api, PEOPLE.empA, sessionId, 1, 1800);
    const first = structuredClone(items("CONFIG#")[0]);
    await saveConfig(api, PEOPLE.empA, sessionId, 2, 1400);
    const res = await saveConfig(api, PEOPLE.empA, sessionId, 3, 900);
    expect(res.body.session.revisions.map((r: any) => r.revision)).toEqual([3, 2, 1]);
    expect(res.body.session.configRevision).toBe(3);
    expect(items("CONFIG#").find((i) => i["revision"] === 1)).toEqual(first);
  });

  it.each([99, 2001, 0, -1, 100000])("rejects out-of-policy %s with 422 and writes nothing", async (ms) => {
    const before = api.db.count(CORE) + api.db.count(EVENTS);
    const res = await saveConfig(api, PEOPLE.empA, sessionId, 1, ms);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("CONFIG_OUT_OF_POLICY");
    expect(api.db.count(CORE) + api.db.count(EVENTS)).toBe(before);
    expect(version()).toBe(1);
  });

  it.each([["string", "1800"], ["float", 1800.5], ["null", null], ["boolean", true], ["array", [1800]], ["object", {}]])(
    "rejects an invalid type (%s) with 400 and writes nothing",
    async (_n, v) => {
      const before = api.db.count(CORE);
      const res = await saveConfig(api, PEOPLE.empA, sessionId, 1, v);
      expect(res.status).toBe(400);
      expect(api.db.count(CORE)).toBe(before);
    },
  );

  it.each([
    ["an unknown config field", { expectedStateVersion: 1, config: { request_timeout_ms: 1800, retries: 3 } }],
    ["a missing config field", { expectedStateVersion: 1, config: {} }],
    ["a forged hash", { expectedStateVersion: 1, config: { request_timeout_ms: 1800 }, configHash: "sha256:" + "0".repeat(64) }],
    ["a forged revision", { expectedStateVersion: 1, config: { request_timeout_ms: 1800 }, revision: 9 }],
    ["a forged result", { expectedStateVersion: 1, config: { request_timeout_ms: 1800 }, passed: true }],
    ["a forged status", { expectedStateVersion: 1, config: { request_timeout_ms: 1800 }, status: "PASSED" }],
    ["no version", { config: { request_timeout_ms: 1800 } }],
    ["a negative version", { expectedStateVersion: -1, config: { request_timeout_ms: 1800 } }],
  ])("rejects %s with 400", async (_n, body) => {
    const res = await api.call({ route: R.saveConfig, as: PEOPLE.empA, params: { sessionId }, body });
    expect(res.status).toBe(400);
    expect(version()).toBe(1);
    expect(items("CONFIG#")).toHaveLength(0);
  });

  it("rejects a missing or malformed body", async () => {
    expect((await api.call({ route: R.saveConfig, as: PEOPLE.empA, params: { sessionId } })).status).toBe(400);
    expect((await api.call({ route: R.saveConfig, as: PEOPLE.empA, params: { sessionId }, rawBody: "{nope" })).status).toBe(400);
  });

  it("rejects saving an identical configuration (no empty revisions)", async () => {
    const res = await saveConfig(api, PEOPLE.empA, sessionId, 1, 800);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("CONFIG_UNCHANGED");
    await saveConfig(api, PEOPLE.empA, sessionId, 1, 1800);
    expect((await saveConfig(api, PEOPLE.empA, sessionId, 2, 1800)).body.code).toBe("CONFIG_UNCHANGED");
  });

  it("rejects a stale expectedStateVersion with 409 and changes nothing", async () => {
    await saveConfig(api, PEOPLE.empA, sessionId, 1, 1800);
    const res = await saveConfig(api, PEOPLE.empA, sessionId, 1, 1400);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("VERSION_CONFLICT");
    expect(items("CONFIG#")).toHaveLength(1);
    expect(version()).toBe(2);
  });

  it("two simultaneous saves based on the same version: exactly one wins, one revision exists", async () => {
    const [a, b] = await Promise.all([
      saveConfig(api, PEOPLE.empA, sessionId, 1, 1800),
      saveConfig(api, PEOPLE.empA, sessionId, 1, 1400),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(items("CONFIG#")).toHaveLength(1);
    expect(version()).toBe(2);
    expect(events()).toHaveLength(2);
  });

  it("a competing write landing between read and write yields 409 and never overwrites the winner", async () => {
    let fired = false;
    api.db.beforeTransact = () => {
      if (fired) return;
      fired = true;
      const cur = storedState();
      api.db.put(CORE, { ...cur, stateVersion: 2, config: { request_timeout_ms: 1000 }, configRevision: 1, configHash: configHash({ request_timeout_ms: 1000 }) });
      api.db.put(CORE, { PK: `SESSION#${sessionId}`, SK: "CONFIG#0000000001", sentinel: "winner" });
    };
    const res = await saveConfig(api, PEOPLE.empA, sessionId, 1, 1800);
    expect(res.status).toBe(409);
    expect(items("CONFIG#")[0]).toMatchObject({ sentinel: "winner" });
  });

  it("caps saved revisions", async () => {
    for (let i = 0; i < 30; i++) {
      expect((await saveConfig(api, PEOPLE.empA, sessionId, version(), 100 + i)).status).toBe(200);
    }
    const res = await saveConfig(api, PEOPLE.empA, sessionId, version(), 500);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("REVISION_LIMIT_REACHED");
    expect(items("CONFIG#")).toHaveLength(30);
  });

  it("a storage failure leaves neither a revision nor a state change", async () => {
    api.db.fail = (cmd) => (cmd === "TransactWrite" ? new Error("simulated outage") : null);
    const res = await saveConfig(api, PEOPLE.empA, sessionId, 1, 1800);
    expect(res.status).toBe(500);
    api.db.fail = null;
    expect(items("CONFIG#")).toHaveLength(0);
    expect(version()).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("running the suite in the runner", () => {
  it("1800 ms: PASSED 5/5, executed by the real runner, tied to the exact revision and hash", async () => {
    const { run } = await saveThenRun(1800);
    expect(run.status).toBe(201);
    const t = run.body.testRun;
    expect(t).toMatchObject({
      status: "PASSED", configRevision: 1, configHash: configHash({ request_timeout_ms: 1800 }),
      configSnapshot: { request_timeout_ms: 1800 }, passedCount: 5, totalCount: 5, current: true, stale: false,
      suiteVersion: 1, errorCode: null, errorMessage: null,
      executor: { kind: "AWS_LAMBDA", runnerRequestId: "runner-req-1", invokeRequestId: "invoke-req-1" },
    });
    expect(t.cases).toHaveLength(5);
    expect(run.body.session.currentEvidence).toEqual({ status: "PASSED", testRunId: t.testRunId });
    expect(run.body.session.activeTestRunId).toBeNull();
  });

  it("800 ms (the baseline, revision 0): FAILED 3/5", async () => {
    const run = await runTests(api, PEOPLE.empA, sessionId, 1);
    expect(run.status).toBe(201);
    expect(run.body.testRun).toMatchObject({ status: "FAILED", configRevision: 0, passedCount: 3, totalCount: 5, current: true });
    expect(run.body.session.currentEvidence.status).toBe("FAILED");
  });

  it("1400 ms: FAILED 4/5 (partial)", async () => {
    const { run } = await saveThenRun(1400);
    expect(run.body.testRun).toMatchObject({ status: "FAILED", passedCount: 4, totalCount: 5 });
  });

  it("sends the runner the server-held snapshot and hash, never anything from the browser", async () => {
    await saveThenRun(1800);
    expect(api.runnerCalls).toHaveLength(1);
    const sent = api.runnerCalls[0]!;
    expect(sent).toMatchObject({
      scenarioId: "inc-104", scenarioVersion: 1, suiteVersion: 1,
      configSnapshot: { request_timeout_ms: 1800 }, configHash: configHash({ request_timeout_ms: 1800 }),
    });
    expect(Object.keys(sent).sort()).toEqual(
      ["configHash", "configSnapshot", "scenarioId", "scenarioVersion", "suiteId", "suiteVersion", "testRunId"],
    );
  });

  it("persists PENDING before invoking and completes with state + event + run in one step", async () => {
    const g = gatedRunner();
    api.useRunner(g.client);
    const p = runTests(api, PEOPLE.empA, sessionId, 1);
    await vi.waitFor(() => expect(api.runnerCalls).toHaveLength(1));
    const pending = items("TEST#");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "PENDING", completedAt: null, cases: [] });
    expect(storedState()).toMatchObject({ stateVersion: 2, activeTestRunId: pending[0]!["testRunId"], testRunsRequested: 1 });
    g.release();
    const res = await p;
    expect(res.status).toBe(201);
    expect(items("TEST#")[0]).toMatchObject({ status: "FAILED" });
    expect(storedState()).toMatchObject({ stateVersion: 3, activeTestRunId: null });
    expect(events().map((e) => e["type"])).toEqual(["INVESTIGATION_STARTED", "TEST_RUN_REQUESTED", "TEST_RUN_COMPLETED"]);
    expect(events()[2]).toMatchObject({ actorSub: "system:scenario-runner", stateVersion: 3 });
  });

  it("event sequence always equals the state version", async () => {
    await saveThenRun(1800);
    await saveThenRun(1400);
    const seqs = events().map((e) => e["stateVersion"]);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(version()).toBe(7);
  });

  it.each([
    ["status", { expectedStateVersion: 1, status: "PASSED" }],
    ["passed", { expectedStateVersion: 1, passed: true }],
    ["a revision", { expectedStateVersion: 1, revision: 1 }],
    ["a config", { expectedStateVersion: 1, config: { request_timeout_ms: 1800 } }],
    ["results", { expectedStateVersion: 1, results: [{ caseId: "x", status: "PASS" }] }],
    ["a hash", { expectedStateVersion: 1, configHash: "sha256:" + "a".repeat(64) }],
    ["a suite", { expectedStateVersion: 1, suiteId: "other" }],
  ])("rejects a forged %s in the run request (400) and never calls the runner", async (_n, body) => {
    const res = await api.call({ route: R.runTests, as: PEOPLE.empA, params: { sessionId }, body });
    expect(res.status).toBe(400);
    expect(api.runnerCalls).toHaveLength(0);
    expect(items("TEST#")).toHaveLength(0);
    expect(version()).toBe(1);
  });

  it("a replayed run request (same version) is a 409 and does not run twice", async () => {
    expect((await runTests(api, PEOPLE.empA, sessionId, 1)).status).toBe(201);
    const again = await runTests(api, PEOPLE.empA, sessionId, 1);
    expect(again.status).toBe(409);
    expect(api.runnerCalls).toHaveLength(1);
    expect(items("TEST#")).toHaveLength(1);
  });

  it("two simultaneous run requests: exactly one runs", async () => {
    const [a, b] = await Promise.all([runTests(api, PEOPLE.empA, sessionId, 1), runTests(api, PEOPLE.empA, sessionId, 1)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(api.runnerCalls).toHaveLength(1);
    expect(items("TEST#")).toHaveLength(1);
  });

  it("allows only one run in flight and reports RUN_IN_PROGRESS", async () => {
    const g = gatedRunner();
    api.useRunner(g.client);
    const p = runTests(api, PEOPLE.empA, sessionId, 1);
    await vi.waitFor(() => expect(api.runnerCalls).toHaveLength(1));
    const second = await runTests(api, PEOPLE.empA, sessionId, 2);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("RUN_IN_PROGRESS");
    expect(api.runnerCalls).toHaveLength(1);
    g.release();
    await p;
  });

  it("polling a running run returns PENDING, not a result", async () => {
    const g = gatedRunner();
    api.useRunner(g.client);
    const p = runTests(api, PEOPLE.empA, sessionId, 1);
    await vi.waitFor(() => expect(api.runnerCalls).toHaveLength(1));
    const runId = items("TEST#")[0]!["testRunId"] as string;
    const polled = await getRun(api, PEOPLE.empA, sessionId, runId);
    expect(polled.status).toBe(200);
    expect(polled.body.testRun).toMatchObject({ status: "PENDING", cases: [], executor: null, completedAt: null, current: true, stale: false });
    expect(polled.body.session.currentEvidence.status).toBe("PENDING");
    g.release();
    await p;
    expect((await getRun(api, PEOPLE.empA, sessionId, runId)).body.testRun.status).toBe("FAILED");
  });

  it("caps test runs per session", async () => {
    for (let i = 0; i < 20; i++) expect((await runTests(api, PEOPLE.empA, sessionId, version())).status).toBe(201);
    const res = await runTests(api, PEOPLE.empA, sessionId, version());
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RUN_LIMIT_REACHED");
    expect(items("TEST#")).toHaveLength(20);
    expect(api.runnerCalls).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------

describe("stale evidence", () => {
  it("a config change after a pass marks the pass STALE without altering or deleting it", async () => {
    const { run } = await saveThenRun(1800);
    const runId = run.body.testRun.testRunId as string;
    const storedBefore = structuredClone(items("TEST#")[0]);

    const saved = await saveConfig(api, PEOPLE.empA, sessionId, version(), 1400);
    const s = saved.body.session;
    expect(s.currentEvidence).toEqual({ status: "NONE", testRunId: null });
    expect(s.testRuns).toHaveLength(1);
    expect(s.testRuns[0]).toMatchObject({ testRunId: runId, status: "PASSED", current: false, stale: true, configRevision: 1 });

    expect(items("TEST#")[0]).toEqual(storedBefore); // history untouched
    expect(JSON.stringify(items("TEST#")[0])).not.toMatch(/stale/i); // never persisted
  });

  it("reverting to an identical value is still a NEW revision, so older evidence stays stale", async () => {
    const first = await saveThenRun(1800);
    await saveConfig(api, PEOPLE.empA, sessionId, version(), 1400);
    const back = await saveConfig(api, PEOPLE.empA, sessionId, version(), 1800);
    expect(back.body.session.configRevision).toBe(3);
    const old = back.body.session.testRuns.find((r: any) => r.testRunId === first.run.body.testRun.testRunId);
    expect(old).toMatchObject({ configRevision: 1, current: false, stale: true });
    expect(back.body.session.currentEvidence.status).toBe("NONE");
  });

  it("a new run on the new config is current while history keeps newest-first order", async () => {
    await saveThenRun(1800);
    const { run } = await saveThenRun(1400);
    const s = (await api.call({ route: R.session, as: PEOPLE.empA, params: { sessionId } })).body.session;
    expect(s.testRuns).toHaveLength(2);
    expect(s.testRuns[0]).toMatchObject({ testRunId: run.body.testRun.testRunId, status: "FAILED", current: true, stale: false });
    expect(s.testRuns[1]).toMatchObject({ status: "PASSED", current: false, stale: true });
    expect(s.currentEvidence).toMatchObject({ status: "FAILED", testRunId: s.testRuns[0].testRunId });
  });

  it("saving while a run is in flight is allowed and the finished run is recorded as STALE", async () => {
    const g = gatedRunner();
    api.useRunner(g.client);
    const p = runTests(api, PEOPLE.empA, sessionId, 1);
    await vi.waitFor(() => expect(api.runnerCalls).toHaveLength(1));
    const saved = await saveConfig(api, PEOPLE.empA, sessionId, 2, 1800);
    expect(saved.status).toBe(200);
    g.release();
    const res = await p;
    expect(res.status).toBe(201);
    expect(res.body.testRun).toMatchObject({ status: "FAILED", configRevision: 0, stale: true, current: false });
    expect(res.body.session).toMatchObject({ configRevision: 1, activeTestRunId: null, stateVersion: 4 });
    expect(res.body.session.currentEvidence.status).toBe("NONE");
  });
});

// ---------------------------------------------------------------------------

describe("runner failure states are recorded honestly (never as a pass)", () => {
  async function runWith(client: RunnerClient) {
    api.useRunner(client);
    const res = await runTests(api, PEOPLE.empA, sessionId, version());
    return res;
  }
  const expectError = (res: any, code: string) => {
    expect(res.status).toBe(201);
    expect(res.body.testRun).toMatchObject({
      status: "ERROR", errorCode: code, cases: [], passedCount: 0, totalCount: 0, executor: null, completedAt: expect.any(String),
    });
    expect(res.body.testRun.errorMessage).toMatch(/No test results|discarded/);
    expect(res.body.session.currentEvidence).toMatchObject({ status: "ERROR" });
    expect(res.body.session.activeTestRunId).toBeNull();
  };

  it("invocation timeout -> RUNNER_TIMEOUT", async () => {
    expectError(await runWith(throwing(new RunnerInvokeError("RUNNER_TIMEOUT"))), "RUNNER_TIMEOUT");
  });
  it("invocation failure -> RUNNER_INVOCATION_FAILED (and raw error text is never stored or returned)", async () => {
    const secret = "secret-internal-detail arn:aws:lambda:us-east-1:123456789012:function:internal-name";
    const res = await runWith(throwing(new Error(secret)));
    expectError(res, "RUNNER_INVOCATION_FAILED");
    expect(res.raw).not.toContain("secret-internal-detail");
    expect(JSON.stringify(api.db.all(CORE))).not.toContain("secret-internal-detail");
    expect(JSON.stringify(api.db.all(EVENTS))).not.toContain("secret-internal-detail");
  });
  it("FunctionError from the runner -> RUNNER_FUNCTION_ERROR", async () => {
    expectError(await runWith(returning(() => ({ errorMessage: "boom" }), "Unhandled")), "RUNNER_FUNCTION_ERROR");
  });
  it.each([
    ["no payload", () => undefined],
    ["a string", () => "PASSED"],
    ["null", () => null],
    ["an extra field", (r: any) => okPayload(r, { sneaky: true })],
    ["an unknown status", (r: any) => okPayload(r, { status: "SUCCESS" })],
    ["no cases", (r: any) => okPayload(r, { cases: [] })],
    ["too many cases", (r: any) => okPayload(r, { cases: Array.from({ length: 21 }, (_, i) => ({ caseId: `c-${i}`, name: "n", status: "PASS", message: "m" })) })],
    ["duplicate case ids", (r: any) => okPayload(r, { cases: [{ caseId: "c-1", name: "n", status: "PASS", message: "m" }, { caseId: "c-1", name: "n", status: "PASS", message: "m" }] })],
    ["PASSED with a failing case (forged pass)", (r: any) => okPayload(r, { cases: [{ caseId: "c-1", name: "n", status: "FAIL", message: "m" }] })],
    ["FAILED with every case passing", (r: any) => okPayload(r, { status: "FAILED" })],
    ["an oversized message", (r: any) => okPayload(r, { cases: [{ caseId: "c-1", name: "n", status: "PASS", message: "x".repeat(500) }] })],
  ])("a malformed response (%s) -> RUNNER_BAD_RESPONSE", async (_n, fn) => {
    expectError(await runWith(returning(fn as any)), "RUNNER_BAD_RESPONSE");
  });
  it.each([
    ["another run id", (r: any) => okPayload(r, { testRunId: "run_0099_aaaaaaaaaaaa" })],
    ["another config hash", (r: any) => okPayload(r, { configHash: configHash({ request_timeout_ms: 2000 }) })],
    ["another suite version", (r: any) => okPayload(r, { suiteVersion: 7 })],
    ["another suite id", (r: any) => okPayload(r, { suiteId: "different-suite" })],
  ])("a response echoing %s -> RUNNER_MISMATCH", async (_n, fn) => {
    expectError(await runWith(returning(fn as any)), "RUNNER_MISMATCH");
  });
  it("a runner that rejects the request -> RUNNER_REJECTED", async () => {
    expectError(await runWith(returning((r) => ({ ok: false, testRunId: r.testRunId, errorCode: "HASH_MISMATCH" }))), "RUNNER_REJECTED");
  });

  it("an ERROR run is final: it does not block the next run and is kept as history", async () => {
    await runWith(throwing(new RunnerInvokeError("RUNNER_TIMEOUT")));
    api.useRunner(inProcessRunner());
    const next = await runTests(api, PEOPLE.empA, sessionId, version());
    expect(next.status).toBe(201);
    expect(next.body.session.testRuns.map((r: any) => r.status)).toEqual(["FAILED", "ERROR"]);
  });

  it("an unconfigured runner fails fast with a 500 and leaves NO pending run or state change", async () => {
    api.breakRunnerConfig();
    const res = await runTests(api, PEOPLE.empA, sessionId, 1);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("An unexpected error occurred");
    expect(items("TEST#")).toHaveLength(0);
    expect(version()).toBe(1);
  });

  it("if the runner fails because the PENDING write failed, the runner is never called", async () => {
    api.db.fail = (cmd) => (cmd === "TransactWrite" ? new Error("simulated outage") : null);
    const res = await runTests(api, PEOPLE.empA, sessionId, 1);
    expect(res.status).toBe(500);
    expect(api.runnerCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("stranded and duplicate completions", () => {
  /** Let the PENDING write succeed, then fail every later write, so the result is never stored. */
  async function strandOne() {
    let transacts = 0;
    api.db.fail = (cmd) => (cmd === "TransactWrite" && ++transacts >= 2 ? new Error("simulated outage") : null);
    const res = await runTests(api, PEOPLE.empA, sessionId, 1);
    api.db.fail = null;
    return res;
  }

  it("a run whose result could not be stored stays PENDING (no invented result)", async () => {
    const res = await strandOne();
    expect(res.status).toBe(500);
    expect(items("TEST#")[0]).toMatchObject({ status: "PENDING" });
    expect(storedState()["activeTestRunId"]).toBe(items("TEST#")[0]!["testRunId"]);
  });

  it("is not closed early; it blocks new runs until the bound passes", async () => {
    await strandOne();
    const runId = items("TEST#")[0]!["testRunId"] as string;
    api.tick(30);
    expect((await getRun(api, PEOPLE.empA, sessionId, runId)).body.testRun.status).toBe("PENDING");
    const blocked = await runTests(api, PEOPLE.empA, sessionId, 2);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("RUN_IN_PROGRESS");
  });

  it("polling after the bound reconciles it to ERROR/STRANDED exactly once", async () => {
    await strandOne();
    const runId = items("TEST#")[0]!["testRunId"] as string;
    api.tick(61);
    const polled = await getRun(api, PEOPLE.empA, sessionId, runId);
    expect(polled.body.testRun).toMatchObject({ status: "ERROR", errorCode: "STRANDED", cases: [], executor: null });
    expect(polled.body.session.activeTestRunId).toBeNull();
    const again = await getRun(api, PEOPLE.empA, sessionId, runId);
    expect(again.body.testRun.status).toBe("ERROR");
    expect(events().filter((e) => e["type"] === "TEST_RUN_COMPLETED")).toHaveLength(1);
  });

  it("a new run request after the bound closes the stranded run (409), then the retry runs", async () => {
    await strandOne();
    api.tick(61);
    const first = await runTests(api, PEOPLE.empA, sessionId, 2);
    expect(first.status).toBe(409);
    expect(first.body.code).toBe("VERSION_CONFLICT");
    expect(items("TEST#")[0]).toMatchObject({ status: "ERROR", errorCode: "STRANDED" });
    const retry = await runTests(api, PEOPLE.empA, sessionId, version());
    expect(retry.status).toBe(201);
    expect(retry.body.session.testRuns.map((r: any) => r.status)).toEqual(["FAILED", "ERROR"]);
  });

  it("a late completion after the run was reconciled cannot overwrite it (first terminal write wins)", async () => {
    const g = gatedRunner();
    api.useRunner(g.client);
    const p = runTests(api, PEOPLE.empA, sessionId, 1);
    await vi.waitFor(() => expect(api.runnerCalls).toHaveLength(1));
    const runId = items("TEST#")[0]!["testRunId"] as string;
    api.tick(61);
    expect((await getRun(api, PEOPLE.empA, sessionId, runId)).body.testRun).toMatchObject({ status: "ERROR", errorCode: "STRANDED" });
    g.release();
    const late = await p;
    expect(late.body.testRun).toMatchObject({ status: "ERROR", errorCode: "STRANDED" });
    expect(items("TEST#")[0]).toMatchObject({ status: "ERROR", errorCode: "STRANDED" });
    expect(events().filter((e) => e["type"] === "TEST_RUN_COMPLETED")).toHaveLength(1);
  });

  it("completion is idempotent: re-polling a finished run writes nothing", async () => {
    const run = await runTests(api, PEOPLE.empA, sessionId, 1);
    const runId = run.body.testRun.testRunId as string;
    const writesBefore = api.db.sent.filter((s) => s.command === "TransactWrite").length;
    await getRun(api, PEOPLE.empA, sessionId, runId);
    await getRun(api, PEOPLE.empA, sessionId, runId);
    expect(api.db.sent.filter((s) => s.command === "TransactWrite").length).toBe(writesBefore);
  });
});

// ---------------------------------------------------------------------------

describe("authorization", () => {
  let other: { sessionId: string };
  beforeEach(async () => {
    const a = await assign(api, PEOPLE.mgrA, PEOPLE.empA2);
    const s = await startAs(api, PEOPLE.empA2, a.body.assignment.assignmentId);
    other = { sessionId: s.body.session.sessionId };
  });

  const calls = (who: any, sid: string, runId = "run_0001_aaaaaaaaaaaa") => [
    () => api.call({ route: R.saveConfig, as: who, params: { sessionId: sid }, body: { expectedStateVersion: 1, config: { request_timeout_ms: 1800 } } }),
    () => api.call({ route: R.runTests, as: who, params: { sessionId: sid }, body: { expectedStateVersion: 1 } }),
    () => api.call({ route: R.getRun, as: who, params: { sessionId: sid, runId } }),
  ];

  it.each([
    ["another employee in the same team", PEOPLE.empA2],
    ["an employee of another team", PEOPLE.empB],
    ["the assigning manager", PEOPLE.mgrA],
    ["another manager", PEOPLE.mgrB],
    ["an org admin", PEOPLE.admin],
    ["a user from another organization", PEOPLE.otherEmp],
    ["an unknown user", "ghost-sub"],
  ])("%s gets an opaque 404 on all three routes and nothing changes", async (_n, who) => {
    const before = JSON.stringify([api.db.all(CORE), api.db.all(EVENTS)]);
    for (const call of calls(who, sessionId)) {
      const res = await call();
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("NOT_FOUND");
    }
    expect(api.runnerCalls).toHaveLength(0);
    expect(JSON.stringify([api.db.all(CORE), api.db.all(EVENTS)])).toBe(before);
  });

  it("requests without verified identity are refused", async () => {
    for (const route of [R.saveConfig, R.runTests, R.getRun]) {
      const res = await api.call({ route, noAuthorizer: true, params: { sessionId, runId: "run_0001_aaaaaaaaaaaa" }, body: { expectedStateVersion: 1 } });
      expect(res.status).toBe(401);
    }
    expect(api.runnerCalls).toHaveLength(0);
  });

  it("a suspended employee can no longer save or run", async () => {
    const m = api.db.get(CORE, { PK: "ORG#northstar-cloud", SK: `MEMBER#${PEOPLE.empA.sub}` })!;
    api.db.put(CORE, { ...m, status: "SUSPENDED" });
    for (const call of calls(PEOPLE.empA, sessionId)) expect((await call()).status).toBe(404);
    expect(api.runnerCalls).toHaveLength(0);
  });

  it("a run id from another employee's session resolves to nothing", async () => {
    const run = await runTests(api, PEOPLE.empA2, other.sessionId, 1);
    expect(run.status).toBe(201);
    const foreignId = run.body.testRun.testRunId as string;
    expect((await getRun(api, PEOPLE.empA, sessionId, foreignId)).status).toBe(404);
    expect((await getRun(api, PEOPLE.empA2, sessionId, foreignId)).status).toBe(404);
    expect((await getRun(api, PEOPLE.empA2, other.sessionId, foreignId)).status).toBe(200);
  });

  it("each session keeps independent revisions and runs", async () => {
    await saveThenRun(1800);
    const theirs = (await api.call({ route: R.session, as: PEOPLE.empA2, params: { sessionId: other.sessionId } })).body.session;
    expect(theirs).toMatchObject({ configRevision: 0, revisions: [], testRuns: [] });
  });

  it("malformed ids are rejected without touching storage for them", async () => {
    for (const bad of ["x", "../etc", "run_1_a", "RUN_0001_AAAAAAAAAAAA", "run_0001_aaaaaaaaaaaaZ"]) {
      expect((await getRun(api, PEOPLE.empA, sessionId, bad)).status).toBe(404);
    }
    expect((await getRun(api, PEOPLE.empA, "ses_nope", "run_0001_aaaaaaaaaaaa")).status).toBe(404);
    expect(SESSION_ID_PATTERN.test(sessionId)).toBe(true);
  });

  it("the actions route cannot record a test result or save config", async () => {
    for (const action of [
      { type: "RECORD_TEST_RESULT", testRunId: "run_0001_aaaaaaaaaaaa", outcome: "PASSED" },
      { type: "SAVE_CONFIG", config: { request_timeout_ms: 1800 } },
      { type: "REQUEST_TEST_RUN", testRunId: "run_0001_aaaaaaaaaaaa" },
    ]) {
      const res = await api.call({ route: R.action, as: PEOPLE.empA, params: { sessionId }, body: { expectedStateVersion: 1, action } });
      expect(res.status).toBe(400);
    }
    expect(version()).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("stored data integrity and compatibility", () => {
  it("a session stored by Phase 2B (no Phase 2C fields) still loads, then upgrades on first write", async () => {
    const cur = storedState();
    const legacy = { ...cur };
    for (const k of ["configRevision", "configHash", "testRunsRequested", "activeTestRunId"]) delete (legacy as any)[k];
    api.db.put(CORE, legacy);

    const got = await api.call({ route: R.session, as: PEOPLE.empA, params: { sessionId } });
    expect(got.status).toBe(200);
    expect(got.body.session).toMatchObject({
      configRevision: 0, configHash: configHash({ request_timeout_ms: 800 }), revisions: [], testRuns: [], activeTestRunId: null,
      currentEvidence: { status: "NONE", testRunId: null },
    });

    const run = await runTests(api, PEOPLE.empA, sessionId, 1);
    expect(run.status).toBe(201);
    expect(storedState()).toMatchObject({ configRevision: 0, testRunsRequested: 1, activeTestRunId: null });
    expect(storedState()["configHash"]).toBe(configHash({ request_timeout_ms: 800 }));
  });

  it("a stored hash that disagrees with the stored config fails closed (500), it is never trusted", async () => {
    api.db.put(CORE, { ...storedState(), configHash: configHash({ request_timeout_ms: 1800 }) });
    const res = await api.call({ route: R.session, as: PEOPLE.empA, params: { sessionId } });
    expect(res.status).toBe(500);
  });

  it("a tampered run (PASSED with failing cases) is never displayed as evidence", async () => {
    const { run } = await saveThenRun(1400);
    const stored = items("TEST#")[0]!;
    api.db.put(CORE, { ...stored, status: "PASSED" }); // forged: FAILED run edited to PASSED
    const s = (await api.call({ route: R.session, as: PEOPLE.empA, params: { sessionId } })).body.session;
    expect(s.testRuns).toHaveLength(0);
    expect(s.currentEvidence.status).toBe("NONE");
    expect(JSON.stringify(s)).not.toContain(run.body.testRun.testRunId);
  });

  it("a tampered run whose snapshot no longer matches its hash is not displayed", async () => {
    await saveThenRun(1400);
    api.db.put(CORE, { ...items("TEST#")[0]!, configSnapshot: { request_timeout_ms: 2000 } });
    const s = (await api.call({ route: R.session, as: PEOPLE.empA, params: { sessionId } })).body.session;
    expect(s.testRuns).toHaveLength(0);
  });

  it("a tampered run (FAILED with every case passing) is never displayed either", async () => {
    await saveThenRun(1800);
    api.db.put(CORE, { ...items("TEST#")[0]!, status: "FAILED" });
    const s = (await api.call({ route: R.session, as: PEOPLE.empA, params: { sessionId } })).body.session;
    expect(s.testRuns).toHaveLength(0);
  });

  it("a tampered revision is not displayed", async () => {
    await saveConfig(api, PEOPLE.empA, sessionId, 1, 1400);
    api.db.put(CORE, { ...items("CONFIG#")[0]!, config: { request_timeout_ms: 2000 } });
    const s = (await api.call({ route: R.session, as: PEOPLE.empA, params: { sessionId } })).body.session;
    expect(s.revisions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("nothing hidden reaches the employee", () => {
  it("run responses expose results, not suite identity, thresholds or infrastructure", async () => {
    const { run } = await saveThenRun(700);
    const t = run.body.testRun;
    expect(Object.keys(t).sort()).toEqual(
      ["cases", "completedAt", "configHash", "configRevision", "configSnapshot", "createdAt", "current", "errorCode", "errorMessage",
        "executor", "passedCount", "stale", "status", "suiteVersion", "testRunId", "totalCount"].sort(),
    );
    expect(Object.keys(t.executor).sort()).toEqual(["invokeRequestId", "kind", "region", "runnerRequestId"]);
    const text = JSON.stringify(t.cases);
    expect(text).not.toMatch(/1200|1600|threshold|expected|minimum|required|at least/i);
    expect(run.raw).not.toMatch(/inc-104-checkout-timeout|suiteId|testSuite|functionName|arn:aws|rubric/i);
  });

  it("the same holds for the session and a polled run", async () => {
    const { run } = await saveThenRun(1400);
    const polled = await getRun(api, PEOPLE.empA, sessionId, run.body.testRun.testRunId);
    const sess = await api.call({ route: R.session, as: PEOPLE.empA, params: { sessionId } });
    for (const r of [polled, sess]) {
      expect(r.raw).not.toMatch(/inc-104-checkout-timeout|suiteId|testSuite|functionName|arn:aws|rubric|savedBySub|requestedBySub/i);
      expect(r.raw).not.toContain(PEOPLE.empA.sub);
    }
  });

  it("unrelated routes and methods remain unrouted", async () => {
    for (const route of ["DELETE /v1/sessions/{sessionId}/config", "PATCH /v1/sessions/{sessionId}/config", "POST /v1/sessions/{sessionId}/test-runs/{runId}", "PUT /v1/sessions/{sessionId}/test-runs"]) {
      const res = await api.call({ route, as: PEOPLE.empA, params: { sessionId, runId: "run_0001_aaaaaaaaaaaa" }, body: {} });
      expect(res.status).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------

describe("transaction conditions hold under races (defence in depth beyond the app-level checks)", () => {
  it("a save cannot commit if the session's owner changed between read and write", async () => {
    let fired = false;
    api.db.beforeTransact = () => {
      if (fired) return;
      fired = true;
      api.db.put(CORE, { ...storedState(), employeeSub: "someone-else-sub" }); // ownership moved, version unchanged
    };
    const res = await saveConfig(api, PEOPLE.empA, sessionId, 1, 1800);
    expect(res.status).not.toBe(200);
    expect(storedState()["employeeSub"]).toBe("someone-else-sub");
    expect(items("CONFIG#")).toHaveLength(0);
  });

  it("a completion that raced with a save re-reads and keeps the save (no lost update)", async () => {
    const g = gatedRunner();
    api.useRunner(g.client);
    const p = runTests(api, PEOPLE.empA, sessionId, 1);
    await vi.waitFor(() => expect(api.runnerCalls).toHaveLength(1));

    // The completion is the next transaction. Just before it commits, another writer lands a save.
    let fired = false;
    api.db.beforeTransact = () => {
      if (fired) return;
      fired = true;
      const cur = storedState();
      api.db.put(CORE, {
        ...cur,
        stateVersion: (cur["stateVersion"] as number) + 1,
        config: { request_timeout_ms: 1800 },
        configRevision: 1,
        configHash: configHash({ request_timeout_ms: 1800 }),
      });
    };
    g.release();
    const res = await p;
    expect(res.status).toBe(201);
    expect(storedState()).toMatchObject({ config: { request_timeout_ms: 1800 }, configRevision: 1, stateVersion: 4, activeTestRunId: null });
    expect(res.body.testRun).toMatchObject({ status: "FAILED", configRevision: 0, stale: true });
  });

  it("a run that became terminal by another path is never overwritten by a late completion", async () => {
    const g = gatedRunner();
    api.useRunner(g.client);
    const p = runTests(api, PEOPLE.empA, sessionId, 1);
    await vi.waitFor(() => expect(api.runnerCalls).toHaveLength(1));

    let fired = false;
    api.db.beforeTransact = () => {
      if (fired) return;
      fired = true;
      const run = items("TEST#")[0]!;
      // Terminal WITHOUT a version bump: only the run's own PENDING condition can notice.
      api.db.put(CORE, { ...run, status: "ERROR", errorCode: "STRANDED", errorMessage: "set elsewhere", completedAt: "2026-11-07T10:05:00.000Z", cases: [], passedCount: 0, totalCount: 0, executor: null });
    };
    g.release();
    await p.catch(() => undefined);
    expect(items("TEST#")[0]).toMatchObject({ status: "ERROR", errorMessage: "set elsewhere" });
  });
});
