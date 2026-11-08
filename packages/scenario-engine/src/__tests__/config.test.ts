import { describe, it, expect } from "vitest";
import {
  MAX_CONFIG_REVISIONS,
  MAX_STATE_VERSION,
  MAX_TEST_RUNS,
  SYSTEM_ACTOR,
  canonicalConfigJson,
  configHash,
  isCurrentRun,
  reduceScenario,
  startSession,
  validateConfig,
  RunnerResponseSchema,
  type PublishedScenario,
  type TransitionResult,
  type WorkplaceAction,
  type WorkplaceState,
} from "../index.js";

const DEF: PublishedScenario = {
  content: {
    scenarioId: "demo-1",
    version: 1,
    title: "Demo",
    summary: "s",
    ticket: {
      id: "T-1", title: "t", severity: "SEV3", status: "OPEN", service: "svc",
      reportedAt: "2026-01-01T00:00:00Z", reporter: "r", description: "d", comments: [],
    },
    runbook: { id: "RB-1", title: "rb", sections: [] },
    diagnostics: { id: "D-1", title: "d", source: "SYNTHETIC", notice: "n", entries: [] },
    initialConfig: { request_timeout_ms: 800 },
  },
  testSuiteId: "suite-1",
  testSuiteVersion: 1,
  rubricVersion: 1,
};
const INIT = { sessionId: "ses_1", assignmentId: "asg_1", organizationId: "org-1", employeeSub: "emp-1" };
const T0 = "2026-11-07T10:00:00.000Z";
const emp = { now: T0, actorSub: "emp-1" };
const sys = { now: T0, actorSub: SYSTEM_ACTOR };
const RUN1 = "run_0001_aaaaaaaaaaaa";

function ok(r: TransitionResult) {
  if (!r.ok) throw new Error(`expected success, got ${r.error.code}`);
  return r;
}
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    Object.values(v as Record<string, unknown>).forEach(deepFreeze);
  }
  return v;
}
const started = (): WorkplaceState => ok(startSession(DEF, INIT, emp)).nextState;
const save = (s: WorkplaceState, ms: unknown): WorkplaceAction => ({
  type: "SAVE_CONFIG", config: { request_timeout_ms: ms }, expectedVersion: s.stateVersion,
});
const code = (r: TransitionResult) => (r.ok ? "OK" : r.error.code);

describe("validateConfig", () => {
  it("accepts integers on the policy boundaries", () => {
    expect(validateConfig({ request_timeout_ms: 100 }).ok).toBe(true);
    expect(validateConfig({ request_timeout_ms: 2000 }).ok).toBe(true);
  });
  it.each([99, 2001, 0, -5])("rejects %s as out of policy", (n) => {
    const r = validateConfig({ request_timeout_ms: n });
    expect(r.ok ? "OK" : r.code).toBe("CONFIG_OUT_OF_POLICY");
  });
  it.each([
    ["string", "800"], ["float", 800.5], ["NaN", NaN], ["Infinity", Infinity],
    ["null", null], ["boolean", true], ["undefined", undefined], ["unsafe integer", 2 ** 60],
  ])("rejects %s as invalid", (_n, v) => {
    const r = validateConfig({ request_timeout_ms: v });
    expect(r.ok ? "OK" : r.code).toBe("INVALID_CONFIG");
  });
  it.each([null, "x", 5, [], [800], {}, { foo: 1 }, { request_timeout_ms: 800, extra: 1 }, { request_timeout_msx: 800 }])(
    "rejects a wrongly shaped config %j",
    (v) => {
      const r = validateConfig(v);
      expect(r.ok ? "OK" : r.code).toBe("INVALID_CONFIG");
    },
  );
  it("returns a copy, never the input object", () => {
    const input = { request_timeout_ms: 900 };
    const r = validateConfig(input);
    expect(r.ok && r.config).toEqual(input);
    expect(r.ok && r.config).not.toBe(input);
  });
});

describe("configHash", () => {
  it("is deterministic and sha256-prefixed", () => {
    const h = configHash({ request_timeout_ms: 800 });
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(configHash({ request_timeout_ms: 800 })).toBe(h);
  });
  it("differs for different values and is insensitive to key order", () => {
    expect(configHash({ request_timeout_ms: 800 })).not.toBe(configHash({ request_timeout_ms: 801 }));
    expect(canonicalConfigJson({ request_timeout_ms: 800 })).toBe('{"request_timeout_ms":800}');
  });
});

describe("SAVE_CONFIG", () => {
  it("creates revision N+1, recomputes the hash and emits exactly one CONFIG_SAVED event", () => {
    const s = started();
    const r = ok(reduceScenario(DEF, s, save(s, 1800), emp));
    expect(r.nextState).toMatchObject({
      config: { request_timeout_ms: 1800 }, configRevision: 1, stateVersion: 2,
      configHash: configHash({ request_timeout_ms: 1800 }),
    });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: "CONFIG_SAVED", sequence: 2, actorSub: "emp-1" });
    expect(r.events[0]?.payload).toMatchObject({ revision: 1, request_timeout_ms: 1800 });
  });
  it("is pure: frozen inputs are not mutated and the result is repeatable", () => {
    const s = deepFreeze(started());
    const a = reduceScenario(DEF, s, save(s, 1500), emp);
    const b = reduceScenario(DEF, s, save(s, 1500), emp);
    expect(a).toEqual(b);
    expect(s.configRevision).toBe(0);
  });
  it("rejects invalid / out-of-policy values without changing anything", () => {
    const s = started();
    expect(code(reduceScenario(DEF, s, save(s, 50), emp))).toBe("CONFIG_OUT_OF_POLICY");
    expect(code(reduceScenario(DEF, s, save(s, "800"), emp))).toBe("INVALID_CONFIG");
  });
  it("rejects saving an identical configuration", () => {
    const s = started();
    expect(code(reduceScenario(DEF, s, save(s, 800), emp))).toBe("CONFIG_UNCHANGED");
  });
  it("rejects a stale version with the current version", () => {
    const s = started();
    const r = reduceScenario(DEF, s, { ...save(s, 1500), expectedVersion: 0 } as WorkplaceAction, emp);
    expect(r).toMatchObject({ ok: false, error: { code: "VERSION_CONFLICT", currentVersion: 1 } });
  });
  it("rejects non-owners and the system identity", () => {
    const s = started();
    expect(code(reduceScenario(DEF, s, save(s, 1500), { now: T0, actorSub: "other" }))).toBe("NOT_OWNER");
    expect(code(reduceScenario(DEF, s, save(s, 1500), sys))).toBe("NOT_AUTHORIZED");
  });
  it("requires an investigating session", () => {
    const pre = { ...started(), phase: "NOT_STARTED" as const, stateVersion: 0 };
    expect(code(reduceScenario(DEF, pre, save(pre, 1500), emp))).toBe("INVALID_TRANSITION");
  });
  it("caps saved revisions", () => {
    const s = { ...started(), configRevision: MAX_CONFIG_REVISIONS };
    expect(code(reduceScenario(DEF, s, save(s, 1500), emp))).toBe("REVISION_LIMIT_REACHED");
  });
  it("is bounded by the overall action cap", () => {
    const s = { ...started(), stateVersion: MAX_STATE_VERSION };
    expect(code(reduceScenario(DEF, s, save(s, 1500), emp))).toBe("LIMIT_REACHED");
  });
});

describe("REQUEST_TEST_RUN / RECORD_TEST_RESULT", () => {
  const req = (s: WorkplaceState, id = RUN1): WorkplaceAction => ({
    type: "REQUEST_TEST_RUN", testRunId: id, expectedVersion: s.stateVersion,
  });
  const rec = (s: WorkplaceState, outcome: "PASSED" | "FAILED" | "ERROR", id = RUN1, errorCode?: string): WorkplaceAction =>
    ({ type: "RECORD_TEST_RESULT", testRunId: id, outcome, expectedVersion: s.stateVersion, ...(errorCode ? { errorCode } : {}) });

  it("request sets the active run and records the exact revision and hash in the event", () => {
    const s = started();
    const r = ok(reduceScenario(DEF, s, req(s), emp));
    expect(r.nextState).toMatchObject({ activeTestRunId: RUN1, testRunsRequested: 1, stateVersion: 2 });
    expect(r.events[0]).toMatchObject({ type: "TEST_RUN_REQUESTED", sequence: 2 });
    expect(r.events[0]?.payload).toMatchObject({ testRunId: RUN1, configRevision: 0, configHash: s.configHash });
  });
  it("allows only one run in flight", () => {
    const s = ok(reduceScenario(DEF, started(), req(started()), emp)).nextState;
    expect(code(reduceScenario(DEF, s, req(s, "run_0002_bbbbbbbbbbbb"), emp))).toBe("RUN_IN_PROGRESS");
  });
  it("caps runs per session", () => {
    const s = { ...started(), testRunsRequested: MAX_TEST_RUNS };
    expect(code(reduceScenario(DEF, s, req(s), emp))).toBe("RUN_LIMIT_REACHED");
  });
  it("only the system identity can record a result; the owner cannot forge one", () => {
    const s0 = started();
    const s = ok(reduceScenario(DEF, s0, req(s0), emp)).nextState;
    expect(code(reduceScenario(DEF, s, rec(s, "PASSED"), emp))).toBe("NOT_AUTHORIZED");
    expect(code(reduceScenario(DEF, s, rec(s, "PASSED"), { now: T0, actorSub: "other" }))).toBe("NOT_AUTHORIZED");
    expect(code(reduceScenario(DEF, s, req(s), sys))).toBe("NOT_AUTHORIZED");
  });
  it("records a result for the active run, clears it, and frees the next request", () => {
    const s0 = started();
    const s1 = ok(reduceScenario(DEF, s0, req(s0), emp)).nextState;
    const r = ok(reduceScenario(DEF, s1, rec(s1, "ERROR", RUN1, "STRANDED"), sys));
    expect(r.nextState.activeTestRunId).toBeNull();
    expect(r.events[0]).toMatchObject({ type: "TEST_RUN_COMPLETED", actorSub: SYSTEM_ACTOR });
    expect(r.events[0]?.payload).toMatchObject({ outcome: "ERROR", errorCode: "STRANDED" });
    expect(code(reduceScenario(DEF, r.nextState, req(r.nextState, "run_0002_bbbbbbbbbbbb"), emp))).toBe("OK");
  });
  it("rejects a result for a run that is not active (duplicate or wrong id)", () => {
    const s0 = started();
    expect(code(reduceScenario(DEF, s0, rec(s0, "PASSED"), sys))).toBe("INVALID_TRANSITION");
    const s1 = ok(reduceScenario(DEF, s0, req(s0), emp)).nextState;
    expect(code(reduceScenario(DEF, s1, rec(s1, "PASSED", "run_0009_cccccccccccc"), sys))).toBe("INVALID_TRANSITION");
  });
  it("a completion is still possible when the action cap is reached", () => {
    const s = { ...started(), stateVersion: MAX_STATE_VERSION, activeTestRunId: RUN1 };
    expect(code(reduceScenario(DEF, s, rec(s, "FAILED"), sys))).toBe("OK");
  });
});

describe("isCurrentRun", () => {
  const s = { configRevision: 2, configHash: "sha256:" + "a".repeat(64) };
  it("requires revision, hash and suite version to all match", () => {
    expect(isCurrentRun({ configRevision: 2, configHash: s.configHash, suiteVersion: 1 }, s, 1)).toBe(true);
    expect(isCurrentRun({ configRevision: 1, configHash: s.configHash, suiteVersion: 1 }, s, 1)).toBe(false);
    expect(isCurrentRun({ configRevision: 2, configHash: "sha256:" + "b".repeat(64), suiteVersion: 1 }, s, 1)).toBe(false);
    expect(isCurrentRun({ configRevision: 2, configHash: s.configHash, suiteVersion: 1 }, s, 2)).toBe(false);
  });
});

describe("RunnerResponseSchema", () => {
  const good = {
    ok: true, testRunId: RUN1, suiteId: "s", suiteVersion: 1, configHash: "sha256:" + "a".repeat(64),
    status: "FAILED", cases: [{ caseId: "c-1", name: "n", status: "FAIL", message: "m" }],
    executor: { requestId: "r", region: "us-east-1" },
  };
  it("accepts a well-formed response and rejects extras / bad shapes", () => {
    expect(RunnerResponseSchema.safeParse(good).success).toBe(true);
    expect(RunnerResponseSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
    expect(RunnerResponseSchema.safeParse({ ...good, status: "PENDING" }).success).toBe(false);
    expect(RunnerResponseSchema.safeParse({ ...good, cases: [] }).success).toBe(false);
    expect(RunnerResponseSchema.safeParse({ ...good, cases: Array(21).fill(good.cases[0]) }).success).toBe(false);
    expect(RunnerResponseSchema.safeParse({ ok: false, testRunId: RUN1, errorCode: "BOOM" }).success).toBe(false);
  });
});
