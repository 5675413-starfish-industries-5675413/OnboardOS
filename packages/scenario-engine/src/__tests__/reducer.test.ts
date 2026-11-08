import { describe, it, expect } from "vitest";
import {
  MAX_STATE_VERSION,
  createSession,
  reduceScenario,
  startSession,
  type PublishedScenario,
  type SessionInit,
  type TransitionContext,
  type TransitionResult,
  type WorkplaceAction,
  type WorkplaceState,
} from "../index.js";

// ---------------------------------------------------------------------------
// A minimal inline definition: the engine must be testable without any fixtures.
// ---------------------------------------------------------------------------

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

const INIT: SessionInit = {
  sessionId: "ses_1", assignmentId: "asg_1", organizationId: "org-1", employeeSub: "emp-1",
};
const T0 = "2026-11-07T10:00:00.000Z";
const ctx = (now = T0, actorSub = "emp-1"): TransitionContext => ({ now, actorSub });

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    Object.values(v as Record<string, unknown>).forEach(deepFreeze);
  }
  return v;
}

function ok(r: TransitionResult) {
  if (!r.ok) throw new Error(`expected success, got ${r.error.code}: ${r.error.message}`);
  return r;
}
function startedState(): WorkplaceState {
  return ok(startSession(DEF, INIT, ctx())).nextState;
}
const open = (type: "OPEN_TICKET" | "OPEN_RUNBOOK" | "OPEN_DIAGNOSTICS", v: number): WorkplaceAction =>
  type === "OPEN_TICKET" ? { type, ticketId: "T-1", expectedVersion: v }
  : type === "OPEN_RUNBOOK" ? { type, runbookId: "RB-1", expectedVersion: v }
  : { type, diagnosticsId: "D-1", expectedVersion: v };

// ---------------------------------------------------------------------------

describe("createSession / startSession", () => {
  it("creates a pre-start session at version 0 with the scenario's starting config", () => {
    const s = createSession(DEF, INIT, T0);
    expect(s).toMatchObject({
      sessionId: "ses_1", assignmentId: "asg_1", organizationId: "org-1", employeeSub: "emp-1",
      scenarioId: "demo-1", scenarioVersion: 1, phase: "NOT_STARTED", stateVersion: 0,
      config: { request_timeout_ms: 800 },
      viewed: { ticket: false, runbook: false, diagnostics: false },
      startedAt: null, updatedAt: T0,
    });
  });

  it("copies the starting config instead of aliasing the shared definition", () => {
    const s = createSession(DEF, INIT, T0);
    expect(s.config).not.toBe(DEF.content.initialConfig);
    expect(s.config).toEqual(DEF.content.initialConfig);
  });

  it("start produces version 1, phase INVESTIGATING and exactly one INVESTIGATION_STARTED event", () => {
    const r = ok(startSession(DEF, INIT, ctx()));
    expect(r.nextState).toMatchObject({ phase: "INVESTIGATING", stateVersion: 1, startedAt: T0 });
    expect(r.events).toEqual([
      {
        sessionId: "ses_1", sequence: 1, type: "INVESTIGATION_STARTED", occurredAt: T0, actorSub: "emp-1",
        payload: { scenarioId: "demo-1", scenarioVersion: 1 },
      },
    ]);
  });

  it("rejects start by someone other than the owning employee", () => {
    const r = startSession(DEF, INIT, ctx(T0, "someone-else"));
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_OWNER" } });
  });
});

describe("permitted actions and state changes", () => {
  it.each([
    ["OPEN_TICKET", "ticket", "TICKET_OPENED", { ticketId: "T-1" }],
    ["OPEN_RUNBOOK", "runbook", "RUNBOOK_OPENED", { runbookId: "RB-1" }],
    ["OPEN_DIAGNOSTICS", "diagnostics", "DIAGNOSTICS_OPENED", { diagnosticsId: "D-1" }],
  ] as const)("%s marks %s viewed, bumps the version by one and emits one event", (type, key, evType, payload) => {
    const s = startedState();
    const r = ok(reduceScenario(DEF, s, open(type, 1), ctx("2026-11-07T10:05:00.000Z")));

    expect(r.nextState.viewed[key]).toBe(true);
    expect(r.nextState.stateVersion).toBe(2);
    expect(r.nextState.updatedAt).toBe("2026-11-07T10:05:00.000Z");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ sequence: 2, type: evType, payload, actorSub: "emp-1" });
    // Other flags are untouched.
    for (const other of ["ticket", "runbook", "diagnostics"] as const) {
      if (other !== key) expect(r.nextState.viewed[other]).toBe(false);
    }
  });

  it("never changes the working config (config edits are not part of this slice)", () => {
    let s = startedState();
    for (const t of ["OPEN_TICKET", "OPEN_RUNBOOK", "OPEN_DIAGNOSTICS"] as const) {
      s = ok(reduceScenario(DEF, s, open(t, s.stateVersion), ctx())).nextState;
    }
    expect(s.config).toEqual({ request_timeout_ms: 800 });
  });

  it("keeps version and event sequence in lockstep across a whole session", () => {
    let s = startedState();
    const sequences = [1];
    for (const t of ["OPEN_TICKET", "OPEN_RUNBOOK", "OPEN_DIAGNOSTICS", "OPEN_TICKET"] as const) {
      const r = ok(reduceScenario(DEF, s, open(t, s.stateVersion), ctx()));
      expect(r.events).toHaveLength(1);
      expect(r.nextState.stateVersion).toBe(s.stateVersion + 1);
      expect(r.events[0]?.sequence).toBe(r.nextState.stateVersion);
      sequences.push(r.events[0]?.sequence ?? -1);
      s = r.nextState;
    }
    expect(sequences).toEqual([1, 2, 3, 4, 5]); // contiguous, no gaps, no duplicates
  });

  it("allows re-opening an item: it is a real action, recorded again", () => {
    const s = ok(reduceScenario(DEF, startedState(), open("OPEN_TICKET", 1), ctx())).nextState;
    const again = ok(reduceScenario(DEF, s, open("OPEN_TICKET", 2), ctx()));
    expect(again.nextState.stateVersion).toBe(3);
    expect(again.events[0]?.type).toBe("TICKET_OPENED");
  });
});

describe("invalid state transitions", () => {
  it("rejects START_INVESTIGATION on an already-started session", () => {
    const r = reduceScenario(DEF, startedState(), { type: "START_INVESTIGATION", expectedVersion: 1 }, ctx());
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
  });

  it.each(["OPEN_TICKET", "OPEN_RUNBOOK", "OPEN_DIAGNOSTICS"] as const)(
    "rejects %s before the investigation has started",
    (type) => {
      const pre = createSession(DEF, INIT, T0);
      expect(reduceScenario(DEF, pre, open(type, 0), ctx())).toMatchObject({
        ok: false, error: { code: "INVALID_TRANSITION" },
      });
    },
  );

  it.each([
    ["OPEN_TICKET", { type: "OPEN_TICKET", ticketId: "NOPE", expectedVersion: 1 }],
    ["OPEN_RUNBOOK", { type: "OPEN_RUNBOOK", runbookId: "NOPE", expectedVersion: 1 }],
    ["OPEN_DIAGNOSTICS", { type: "OPEN_DIAGNOSTICS", diagnosticsId: "NOPE", expectedVersion: 1 }],
  ] as const)("rejects %s for an id that is not in this scenario", (_n, action) => {
    expect(reduceScenario(DEF, startedState(), action, ctx())).toMatchObject({
      ok: false, error: { code: "UNKNOWN_OBJECT" },
    });
  });

  it("rejects an id that exists in the scenario but belongs to a different item type", () => {
    // The runbook id presented as a ticket id must not be accepted.
    const r = reduceScenario(DEF, startedState(), { type: "OPEN_TICKET", ticketId: "RB-1", expectedVersion: 1 }, ctx());
    expect(r).toMatchObject({ ok: false, error: { code: "UNKNOWN_OBJECT" } });
  });

  it("rejects an action when the session is bound to a different scenario version", () => {
    const v2: PublishedScenario = { ...DEF, content: { ...DEF.content, version: 2 } };
    expect(reduceScenario(v2, startedState(), open("OPEN_TICKET", 1), ctx())).toMatchObject({
      ok: false, error: { code: "SCENARIO_MISMATCH" },
    });
  });

  it("rejects actions beyond the per-session cap", () => {
    const atCap: WorkplaceState = { ...startedState(), stateVersion: MAX_STATE_VERSION };
    expect(reduceScenario(DEF, atCap, open("OPEN_TICKET", MAX_STATE_VERSION), ctx())).toMatchObject({
      ok: false, error: { code: "LIMIT_REACHED" },
    });
  });
});

describe("expected-version conflicts", () => {
  it.each([[0], [2], [99]])("rejects expectedVersion %i when the state is at 1", (v) => {
    const r = reduceScenario(DEF, startedState(), open("OPEN_TICKET", v), ctx());
    expect(r).toMatchObject({ ok: false, error: { code: "VERSION_CONFLICT", currentVersion: 1 } });
  });

  it("a stale action is rejected, not merged: the second of two same-version actions fails", () => {
    const s0 = startedState();
    const first = ok(reduceScenario(DEF, s0, open("OPEN_TICKET", 1), ctx()));
    // A second client that also read version 1 now acts on the original state.
    const second = reduceScenario(DEF, first.nextState, open("OPEN_RUNBOOK", 1), ctx());
    expect(second).toMatchObject({ ok: false, error: { code: "VERSION_CONFLICT", currentVersion: 2 } });
  });
});

describe("ownership", () => {
  it("rejects a different actor and does not reveal the current version", () => {
    const r = reduceScenario(DEF, startedState(), open("OPEN_TICKET", 1), ctx(T0, "intruder"));
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_OWNER" } });
    expect(JSON.stringify(r)).not.toContain("currentVersion");
  });

  it("checks ownership before the version, so a non-owner cannot probe versions", () => {
    const r = reduceScenario(DEF, startedState(), open("OPEN_TICKET", 999), ctx(T0, "intruder"));
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_OWNER" } });
  });
});

describe("purity and determinism", () => {
  it("never mutates its inputs (deep-frozen state, definition, action and context)", () => {
    const frozenDef = deepFreeze(structuredClone(DEF));
    const frozenState = deepFreeze(structuredClone(startedState()));
    const action = deepFreeze(open("OPEN_TICKET", 1));
    const frozenCtx = deepFreeze(ctx());
    const before = JSON.stringify([frozenDef, frozenState, action, frozenCtx]);

    // Would throw TypeError (strict mode) on any attempted mutation.
    const r = ok(reduceScenario(frozenDef, frozenState, action, frozenCtx));

    expect(JSON.stringify([frozenDef, frozenState, action, frozenCtx])).toBe(before);
    expect(r.nextState).not.toBe(frozenState);
    expect(r.nextState.viewed).not.toBe(frozenState.viewed);
    expect(frozenState.viewed.ticket).toBe(false);
  });

  it("returns identical results for identical inputs", () => {
    const s = startedState();
    const a = reduceScenario(DEF, s, open("OPEN_DIAGNOSTICS", 1), ctx());
    const b = reduceScenario(DEF, s, open("OPEN_DIAGNOSTICS", 1), ctx());
    expect(a).toEqual(b);
  });

  it("takes time only from the context: a different clock changes only timestamps", () => {
    const s = startedState();
    const a = ok(reduceScenario(DEF, s, open("OPEN_TICKET", 1), ctx("2026-01-01T00:00:00.000Z")));
    const b = ok(reduceScenario(DEF, s, open("OPEN_TICKET", 1), ctx("2030-01-01T00:00:00.000Z")));
    expect({ ...a.nextState, updatedAt: "" }).toEqual({ ...b.nextState, updatedAt: "" });
  });

  it("does not let a rejected action change anything it was given", () => {
    const s = deepFreeze(structuredClone(startedState()));
    const before = JSON.stringify(s);
    reduceScenario(DEF, s, open("OPEN_TICKET", 42), ctx());
    expect(JSON.stringify(s)).toBe(before);
  });
});
