import { describe, it, expect } from "vitest";
import {
  MAX_STATE_VERSION,
  SYSTEM_ACTOR,
  createSession,
  reduceScenario,
  startSession,
  type PublishedScenario,
  type TransitionResult,
  type WorkplaceAction,
  type WorkplaceState,
} from "../index.js";

const DEF: PublishedScenario = {
  content: {
    scenarioId: "demo-1", version: 1, title: "Demo", summary: "s",
    ticket: { id: "T-1", title: "t", severity: "SEV3", status: "OPEN", service: "svc", reportedAt: "2026-01-01T00:00:00Z", reporter: "r", description: "d", comments: [] },
    runbook: { id: "RB-1", title: "rb", sections: [] },
    diagnostics: { id: "D-1", title: "d", source: "SYNTHETIC", notice: "n", entries: [] },
    initialConfig: { request_timeout_ms: 800 },
  },
  testSuiteId: "suite-1", testSuiteVersion: 1, rubricVersion: 1,
};
const INIT = { sessionId: "ses_1", assignmentId: "asg_1", organizationId: "org-1", employeeSub: "emp-1" };
const T0 = "2026-11-07T10:00:00.000Z";
const emp = { now: T0, actorSub: "emp-1" };
const mgr = { now: T0, actorSub: "mgr-1" };
const sys = { now: T0, actorSub: SYSTEM_ACTOR };
const SUB = "sub_01_" + "a".repeat(32);

const ok = (r: TransitionResult) => {
  if (!r.ok) throw new Error(`expected success, got ${r.error.code}`);
  return r;
};
const code = (r: TransitionResult) => (r.ok ? "OK" : r.error.code);
const started = (): WorkplaceState => ok(startSession(DEF, INIT, emp)).nextState;
const submit = (s: WorkplaceState, id = SUB): WorkplaceAction => ({ type: "SUBMIT_REPORT", submissionId: id, expectedVersion: s.stateVersion });
const review = (s: WorkplaceState, decision: "APPROVE" | "REQUEST_REVISION" = "APPROVE", id = SUB): WorkplaceAction =>
  ({ type: "RECORD_REVIEW", submissionId: id, decision, expectedVersion: s.stateVersion });
const submitted = () => { const s = started(); return ok(reduceScenario(DEF, s, submit(s), emp)).nextState; };

describe("new session fields", () => {
  it("a fresh session is attempt 1, unsubmitted and undecided", () => {
    expect(createSession(DEF, INIT, T0)).toMatchObject({ attemptNumber: 1, submissionId: null, reviewDecision: null });
  });
  it("a later attempt is created with its own attempt number", () => {
    expect(createSession(DEF, { ...INIT, attemptNumber: 3 }, T0).attemptNumber).toBe(3);
  });
});

describe("SUBMIT_REPORT", () => {
  it("locks the attempt, records the submission id and emits exactly one event at the new version", () => {
    const s = started();
    const r = ok(reduceScenario(DEF, s, submit(s), emp));
    expect(r.nextState).toMatchObject({ phase: "SUBMITTED", submissionId: SUB, stateVersion: 2, reviewDecision: null });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: "SUBMISSION_CREATED", sequence: 2, actorSub: "emp-1" });
    expect(r.events[0]?.payload).toMatchObject({ submissionId: SUB, attemptNumber: 1, configRevision: 0, configHash: s.configHash });
  });
  it("a submitted attempt cannot be edited, re-run, re-opened or submitted again", () => {
    const s = submitted();
    const v = s.stateVersion;
    expect(code(reduceScenario(DEF, s, { type: "SAVE_CONFIG", config: { request_timeout_ms: 1800 }, expectedVersion: v }, emp))).toBe("INVALID_TRANSITION");
    expect(code(reduceScenario(DEF, s, { type: "REQUEST_TEST_RUN", testRunId: "run_0001_aaaaaaaaaaaa", expectedVersion: v }, emp))).toBe("INVALID_TRANSITION");
    expect(code(reduceScenario(DEF, s, { type: "OPEN_TICKET", ticketId: "T-1", expectedVersion: v }, emp))).toBe("INVALID_TRANSITION");
    expect(code(reduceScenario(DEF, s, submit(s, "sub_01_" + "b".repeat(32)), emp))).toBe("INVALID_TRANSITION");
  });
  it("is refused before the investigation starts", () => {
    const s = createSession(DEF, INIT, T0);
    expect(code(reduceScenario(DEF, s, submit(s), emp))).toBe("INVALID_TRANSITION");
  });
  it("is refused while a test run is in flight", () => {
    const s0 = started();
    const s1 = ok(reduceScenario(DEF, s0, { type: "REQUEST_TEST_RUN", testRunId: "run_0001_aaaaaaaaaaaa", expectedVersion: 1 }, emp)).nextState;
    expect(code(reduceScenario(DEF, s1, submit(s1), emp))).toBe("RUN_IN_PROGRESS");
  });
  it("rejects a stale version with the current version, a non-owner, and the system identity", () => {
    const s = started();
    expect(reduceScenario(DEF, s, { ...submit(s), expectedVersion: 0 } as WorkplaceAction, emp)).toMatchObject({ ok: false, error: { code: "VERSION_CONFLICT", currentVersion: 1 } });
    expect(code(reduceScenario(DEF, s, submit(s), { now: T0, actorSub: "someone" }))).toBe("NOT_OWNER");
    expect(code(reduceScenario(DEF, s, submit(s), mgr))).toBe("NOT_OWNER");
    expect(code(reduceScenario(DEF, s, submit(s), sys))).toBe("NOT_AUTHORIZED");
  });
  it("is still possible when the session has hit the action cap", () => {
    const s = { ...started(), stateVersion: MAX_STATE_VERSION };
    expect(code(reduceScenario(DEF, s, submit(s), emp))).toBe("OK");
  });
});

describe("RECORD_REVIEW", () => {
  it("records the decision once, bumps the version and emits one REVIEW_DECIDED event", () => {
    const s = submitted();
    const r = ok(reduceScenario(DEF, s, review(s, "REQUEST_REVISION"), mgr));
    expect(r.nextState).toMatchObject({ reviewDecision: "REQUEST_REVISION", stateVersion: 3, phase: "SUBMITTED" });
    expect(r.events[0]).toMatchObject({ type: "REVIEW_DECIDED", sequence: 3, actorSub: "mgr-1" });
    expect(r.events[0]?.payload).toEqual({ submissionId: SUB, decision: "REQUEST_REVISION" });
  });
  it("a second decision is ALREADY_DECIDED, whatever it says", () => {
    const s = ok(reduceScenario(DEF, submitted(), review(submitted()), mgr)).nextState;
    expect(code(reduceScenario(DEF, s, review(s, "APPROVE"), mgr))).toBe("ALREADY_DECIDED");
    expect(code(reduceScenario(DEF, s, review(s, "REQUEST_REVISION"), mgr))).toBe("ALREADY_DECIDED");
  });
  it("the employee cannot review their own work, and neither can the system identity", () => {
    const s = submitted();
    expect(code(reduceScenario(DEF, s, review(s), emp))).toBe("NOT_AUTHORIZED");
    expect(code(reduceScenario(DEF, s, review(s), sys))).toBe("NOT_AUTHORIZED");
  });
  it("only accepts the submission this attempt actually froze", () => {
    const s = submitted();
    expect(code(reduceScenario(DEF, s, review(s, "APPROVE", "sub_01_" + "c".repeat(32)), mgr))).toBe("INVALID_TRANSITION");
  });
  it("cannot review an attempt that was never submitted", () => {
    const s = started();
    expect(code(reduceScenario(DEF, s, review(s), mgr))).toBe("INVALID_TRANSITION");
  });
  it("a stale version conflicts instead of merging", () => {
    const s = submitted();
    expect(reduceScenario(DEF, s, { ...review(s), expectedVersion: 1 } as WorkplaceAction, mgr)).toMatchObject({ ok: false, error: { code: "VERSION_CONFLICT" } });
  });
  it("a decided attempt stays locked for the employee", () => {
    const s = ok(reduceScenario(DEF, submitted(), review(submitted(), "REQUEST_REVISION"), mgr)).nextState;
    expect(code(reduceScenario(DEF, s, { type: "SAVE_CONFIG", config: { request_timeout_ms: 1800 }, expectedVersion: s.stateVersion }, emp))).toBe("INVALID_TRANSITION");
  });
  it("is still possible at the action cap, and does not mutate its input", () => {
    const s = Object.freeze({ ...submitted(), stateVersion: MAX_STATE_VERSION });
    expect(code(reduceScenario(DEF, s, review(s), mgr))).toBe("OK");
    expect(s.reviewDecision).toBeNull();
  });
});
