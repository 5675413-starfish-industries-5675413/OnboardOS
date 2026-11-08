import { beforeEach, describe, expect, it } from "vitest";
import {
  CORE,
  EVENTS,
  ORG,
  PEOPLE,
  OPEN_DIAGNOSTICS,
  OPEN_RUNBOOK,
  OPEN_TICKET,
  R,
  act,
  assign,
  createApi,
  seedMember,
  startAs,
  startedSession,
  type Api,
} from "./harness.js";

let api: Api;
beforeEach(() => {
  api = createApi();
});

const events = () => api.db.all(EVENTS).sort((a, b) => String(a["SK"]).localeCompare(String(b["SK"])));
const sessionKey = (id: string) => ({ PK: `SESSION#${id}`, SK: "STATE" });
const assignmentKey = (id: string) => ({ PK: `ASSIGN#${id}`, SK: "META" });
const getSession = (who: Parameters<Api["call"]>[0]["as"], sessionId: string) =>
  api.call({ route: R.session, as: who, params: { sessionId } });

describe("POST start: creating and persisting the session", () => {
  it("starts the investigation and returns authoritative state with the incident material", async () => {
    const { startRes } = await startedSession(api);
    expect(startRes.status).toBe(201);
    expect(startRes.body.created).toBe(true);

    const s = startRes.body.session;
    expect(s).toMatchObject({
      organizationId: ORG, scenarioId: "inc-104", scenarioVersion: 1,
      phase: "INVESTIGATING", stateVersion: 1,
      config: { request_timeout_ms: 800 },
      viewed: { ticket: false, runbook: false, diagnostics: false },
    });
    expect(s.scenario.ticket.id).toBe("INC-104");
    expect(s.scenario.runbook.id).toBe("RB-CHECKOUT-TIMEOUT");
    expect(s.scenario.diagnostics.source).toBe("SYNTHETIC");
    expect(s.scenario.diagnostics.entries.length).toBeGreaterThan(5);
  });

  it("persists the session, its first event, and the assignment transition together", async () => {
    const { assignmentId, sessionId } = await startedSession(api);

    expect(api.db.get(CORE, sessionKey(sessionId))).toMatchObject({
      entityType: "SESSION_STATE", sessionId, assignmentId, organizationId: ORG,
      employeeSub: PEOPLE.empA.sub, phase: "INVESTIGATING", stateVersion: 1,
      config: { request_timeout_ms: 800 },
    });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      PK: `SESSION#${sessionId}`, SK: "SEQ#0000000001", type: "INVESTIGATION_STARTED",
      stateVersion: 1, actorSub: PEOPLE.empA.sub, organizationId: ORG,
    });
    expect(api.db.get(CORE, assignmentKey(assignmentId))).toMatchObject({
      status: "IN_PROGRESS", sessionId, startedAt: expect.any(String),
    });
  });

  it("makes the assignment visible as IN_PROGRESS with its session to the employee and the manager", async () => {
    const { sessionId } = await startedSession(api);
    const emp = await api.call({ route: R.list, as: PEOPLE.empA, params: { orgId: ORG } });
    const mgr = await api.call({ route: R.list, as: PEOPLE.mgrA, params: { orgId: ORG } });
    for (const r of [emp, mgr]) {
      expect(r.body.assignments[0]).toMatchObject({ status: "IN_PROGRESS", sessionId });
    }
  });

  it("uses deterministic ids: the same assignment always maps to the same session", async () => {
    const a = await startedSession(api);
    const other = createApi();
    const b = await startedSession(other);
    expect(a.sessionId).toBe(b.sessionId);
    expect(a.assignmentId).toBe(b.assignmentId);
  });
});

describe("POST start: idempotency and retries", () => {
  it("a retry returns the same session (200, created=false) and creates nothing new", async () => {
    const { assignmentId, sessionId, startRes } = await startedSession(api);
    api.tick(60);
    const retry = await startAs(api, PEOPLE.empA, assignmentId);

    expect(retry.status).toBe(200);
    expect(retry.body.created).toBe(false);
    expect(retry.body.session.sessionId).toBe(sessionId);
    expect(retry.body.session).toEqual(startRes.body.session);
    expect(events()).toHaveLength(1);
  });

  it("a retry after progress returns the CURRENT state, never a reset one", async () => {
    const { assignmentId, sessionId } = await startedSession(api);
    await act(api, PEOPLE.empA, sessionId, 1, OPEN_TICKET);
    await act(api, PEOPLE.empA, sessionId, 2, OPEN_RUNBOOK);

    const retry = await startAs(api, PEOPLE.empA, assignmentId);
    expect(retry.body.created).toBe(false);
    expect(retry.body.session).toMatchObject({ stateVersion: 3, viewed: { ticket: true, runbook: true, diagnostics: false } });
    expect(events()).toHaveLength(3);
  });

  it("two simultaneous starts yield exactly one session and one event; the loser gets the winner's", async () => {
    const a = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    const id = a.body.assignment.assignmentId;
    const [x, y] = await Promise.all([startAs(api, PEOPLE.empA, id), startAs(api, PEOPLE.empA, id)]);

    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect([x.body.created, y.body.created].sort()).toEqual([false, true]);
    expect(x.body.session.sessionId).toBe(y.body.session.sessionId);
    expect(api.db.all(CORE).filter((i) => i["entityType"] === "SESSION_STATE")).toHaveLength(1);
    expect(events()).toHaveLength(1);
  });

  it("is atomic: a storage failure mid-start leaves NO session, NO event and the assignment still ASSIGNED", async () => {
    const a = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    const id = a.body.assignment.assignmentId;
    api.db.fail = (cmd) => (cmd === "TransactWrite" ? new Error("simulated outage") : null);

    const r = await startAs(api, PEOPLE.empA, id);
    expect(r.status).toBe(500);
    expect(api.db.all(CORE).some((i) => i["entityType"] === "SESSION_STATE")).toBe(false);
    expect(events()).toHaveLength(0);
    expect(api.db.get(CORE, assignmentKey(id))).toMatchObject({ status: "ASSIGNED", sessionId: null });

    // ...and the employee can simply try again.
    api.db.fail = null;
    expect((await startAs(api, PEOPLE.empA, id)).status).toBe(201);
  });

  it("reports a genuine conflict (assignment changed under us) as 409, with nothing written", async () => {
    const a = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    const id = a.body.assignment.assignmentId;
    api.db.beforeTransact = () => {
      api.db.beforeTransact = null;
      api.db.put(CORE, { ...api.db.get(CORE, assignmentKey(id))!, status: "SUBMITTED" });
    };
    const r = await startAs(api, PEOPLE.empA, id);
    expect(r.status).toBe(409);
    expect(api.db.all(CORE).some((i) => i["entityType"] === "SESSION_STATE")).toBe(false);
    expect(events()).toHaveLength(0);
  });

  it("refuses to start an assignment that is no longer startable", async () => {
    const a = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    const id = a.body.assignment.assignmentId;
    api.db.put(CORE, { ...api.db.get(CORE, assignmentKey(id))!, status: "APPROVED" });
    const r = await startAs(api, PEOPLE.empA, id);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("INVALID_ASSIGNMENT_STATE");
  });
});

describe("POST start: who may start", () => {
  let id: string;
  beforeEach(async () => {
    id = (await assign(api, PEOPLE.mgrA, PEOPLE.empA)).body.assignment.assignmentId;
  });

  it.each([
    ["another employee on the same team", PEOPLE.empA2],
    ["an employee on another team", PEOPLE.empB],
    ["the manager who made the assignment", PEOPLE.mgrA],
    ["an org admin", PEOPLE.admin],
    ["an employee of another organization", PEOPLE.otherEmp],
    ["a user with no membership at all", "ghost-sub"],
  ])("denies %s with an opaque 404 and changes nothing", async (_label, who) => {
    const r = await startAs(api, who, id);
    expect(r.status).toBe(404);
    expect(api.db.get(CORE, assignmentKey(id))).toMatchObject({ status: "ASSIGNED", sessionId: null });
    expect(api.db.all(CORE).some((i) => i["entityType"] === "SESSION_STATE")).toBe(false);
    expect(events()).toHaveLength(0);
  });

  it("gives the same 404 for a missing assignment as for someone else's (no existence oracle)", async () => {
    const theirs = await startAs(api, PEOPLE.empA2, id);
    const missing = await startAs(api, PEOPLE.empA2, "asg_" + "0".repeat(32));
    expect({ code: theirs.body.code, message: theirs.body.message }).toEqual({ code: missing.body.code, message: missing.body.message });
  });

  it("denies the assigned employee once their membership is no longer ACTIVE", async () => {
    seedMember(api.db, { ...PEOPLE.empA, status: "SUSPENDED" });
    expect((await startAs(api, PEOPLE.empA, id)).status).toBe(404);
  });

  it("rejects malformed ids without touching storage for them", async () => {
    for (const bad of ["x", "asg_short", "ASSIGN#" + "a".repeat(32), "asg_" + "G".repeat(32), "../../etc"]) {
      expect((await startAs(api, PEOPLE.empA, bad)).status).toBe(404);
    }
  });

  it("requires authentication: no authorizer context or an ID token is a 401", async () => {
    expect((await api.call({ route: R.start, noAuthorizer: true, params: { assignmentId: id } })).status).toBe(401);
    expect((await api.call({ route: R.start, as: PEOPLE.empA, tokenUse: "id", params: { assignmentId: id } })).status).toBe(401);
  });

  it("fails closed with a generic 500 if the assignment's frozen scenario version is unavailable", async () => {
    api.db.put(CORE, { ...api.db.get(CORE, assignmentKey(id))!, scenarioVersion: 99 });
    const r = await startAs(api, PEOPLE.empA, id);
    expect(r.status).toBe(500);
    expect(r.body.code).toBe("INTERNAL_ERROR");
  });
});

describe("GET session: authoritative state, owner only", () => {
  it("returns the same state after a refresh, including from a brand-new Lambda instance", async () => {
    const { sessionId, session } = await startedSession(api);
    await act(api, PEOPLE.empA, sessionId, 1, OPEN_TICKET);

    const sameInstance = await getSession(PEOPLE.empA, sessionId);
    const freshInstance = createApi(api.db); // new process, new clock, same persisted data
    freshInstance.tick(3600);
    const afterColdStart = await freshInstance.call({ route: R.session, as: PEOPLE.empA, params: { sessionId } });

    expect(sameInstance.status).toBe(200);
    expect(afterColdStart.body).toEqual(sameInstance.body);
    expect(afterColdStart.body.session).toMatchObject({ stateVersion: 2, viewed: { ticket: true } });
    expect(afterColdStart.body.session.scenario).toEqual(session.scenario);
  });

  it("is never cacheable", async () => {
    const { sessionId } = await startedSession(api);
    expect((await getSession(PEOPLE.empA, sessionId)).headers["Cache-Control"]).toBe("no-store");
  });

  it.each([
    ["another employee on the same team", PEOPLE.empA2],
    ["an employee on another team", PEOPLE.empB],
    ["the assigning manager (preview is not part of this slice)", PEOPLE.mgrA],
    ["an org admin", PEOPLE.admin],
    ["an employee of another organization", PEOPLE.otherEmp],
    ["an unknown user", "ghost-sub"],
  ])("denies %s with an opaque 404", async (_label, who) => {
    const { sessionId } = await startedSession(api);
    const r = await getSession(who, sessionId);
    expect(r.status).toBe(404);
    expect(r.raw).not.toContain("INC-104");
  });

  it("denies the owner after their membership is suspended", async () => {
    const { sessionId } = await startedSession(api);
    seedMember(api.db, { ...PEOPLE.empA, status: "SUSPENDED" });
    expect((await getSession(PEOPLE.empA, sessionId)).status).toBe(404);
  });

  it("gives the same 404 for a missing session as for someone else's", async () => {
    const { sessionId } = await startedSession(api);
    const theirs = await getSession(PEOPLE.empA2, sessionId);
    const missing = await getSession(PEOPLE.empA2, "ses_" + "0".repeat(32));
    expect({ code: theirs.body.code, message: theirs.body.message }).toEqual({ code: missing.body.code, message: missing.body.message });
  });

  it("rejects malformed ids and unauthenticated callers", async () => {
    expect((await getSession(PEOPLE.empA, "nope")).status).toBe(404);
    expect((await api.call({ route: R.session, noAuthorizer: true, params: { sessionId: "ses_" + "a".repeat(32) } })).status).toBe(401);
  });

  it("fails closed (generic 500) on a corrupt stored session instead of returning it", async () => {
    const { sessionId } = await startedSession(api);
    api.db.put(CORE, { ...api.db.get(CORE, sessionKey(sessionId))!, phase: "WARP_SPEED" });
    const r = await getSession(PEOPLE.empA, sessionId);
    expect(r.status).toBe(500);
    expect(r.raw).not.toContain("WARP_SPEED");
  });

  it("fails closed when a session's key and content disagree", async () => {
    const { sessionId } = await startedSession(api);
    api.db.put(CORE, { ...api.db.get(CORE, sessionKey(sessionId))!, sessionId: "ses_" + "c".repeat(32) });
    expect((await getSession(PEOPLE.empA, sessionId)).status).toBe(500);
  });
});

describe("POST actions: state changes, events, and persistence", () => {
  it("opens the ticket: version 2, viewed flag set, one matching event", async () => {
    const { sessionId } = await startedSession(api);
    const r = await act(api, PEOPLE.empA, sessionId, 1, OPEN_TICKET);

    expect(r.status).toBe(200);
    expect(r.body.session).toMatchObject({ stateVersion: 2, viewed: { ticket: true, runbook: false, diagnostics: false } });
    expect(events().map((e) => [e["SK"], e["type"]])).toEqual([
      ["SEQ#0000000001", "INVESTIGATION_STARTED"],
      ["SEQ#0000000002", "TICKET_OPENED"],
    ]);
    expect(events()[1]).toMatchObject({ payload: { ticketId: "INC-104" }, actorSub: PEOPLE.empA.sub, stateVersion: 2 });
  });

  it("keeps the stored version and the event stream in lockstep across a session", async () => {
    const { sessionId } = await startedSession(api);
    await act(api, PEOPLE.empA, sessionId, 1, OPEN_TICKET);
    await act(api, PEOPLE.empA, sessionId, 2, OPEN_RUNBOOK);
    await act(api, PEOPLE.empA, sessionId, 3, OPEN_DIAGNOSTICS);

    const stored = api.db.get(CORE, sessionKey(sessionId))!;
    expect(stored["stateVersion"]).toBe(4);
    expect(events().map((e) => e["stateVersion"])).toEqual([1, 2, 3, 4]); // contiguous
    expect(stored["viewed"]).toEqual({ ticket: true, runbook: true, diagnostics: true });
  });

  it("never changes the working config", async () => {
    const { sessionId } = await startedSession(api);
    await act(api, PEOPLE.empA, sessionId, 1, OPEN_TICKET);
    expect((await getSession(PEOPLE.empA, sessionId)).body.session.config).toEqual({ request_timeout_ms: 800 });
  });

  it("an action's result survives a restart", async () => {
    const { sessionId } = await startedSession(api);
    await act(api, PEOPLE.empA, sessionId, 1, OPEN_RUNBOOK);
    const cold = createApi(api.db);
    const r = await cold.call({ route: R.session, as: PEOPLE.empA, params: { sessionId } });
    expect(r.body.session.viewed.runbook).toBe(true);
  });
});

describe("POST actions: expected-version conflicts and concurrent updates", () => {
  it.each([[0], [2], [50]])("rejects a stale/future expectedStateVersion %i with 409 and writes nothing", async (v) => {
    const { sessionId } = await startedSession(api);
    const r = await act(api, PEOPLE.empA, sessionId, v, OPEN_TICKET);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("VERSION_CONFLICT");
    expect(events()).toHaveLength(1);
    expect(api.db.get(CORE, sessionKey(sessionId))!["stateVersion"]).toBe(1);
  });

  it("two simultaneous actions on the same version: exactly one wins, the other gets 409", async () => {
    const { sessionId } = await startedSession(api);
    const [a, b] = await Promise.all([
      act(api, PEOPLE.empA, sessionId, 1, OPEN_TICKET),
      act(api, PEOPLE.empA, sessionId, 1, OPEN_RUNBOOK),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const stored = api.db.get(CORE, sessionKey(sessionId))!;
    expect(stored["stateVersion"]).toBe(2);
    expect(events()).toHaveLength(2); // start + the single winner: the loser left no event
    // Exactly one of the two artifacts was recorded; the loser's change is absent, not merged.
    const viewed = stored["viewed"] as Record<string, boolean>;
    expect(Object.values(viewed).filter(Boolean)).toHaveLength(1);
  });

  it("a competing writer landing between our read and our write makes us fail with 409, never overwrite", async () => {
    const { sessionId } = await startedSession(api);
    api.db.beforeTransact = () => {
      api.db.beforeTransact = null;
      const cur = api.db.get(CORE, sessionKey(sessionId))!;
      api.db.put(CORE, { ...cur, stateVersion: 2, viewed: { ...(cur["viewed"] as object), diagnostics: true } });
    };
    const r = await act(api, PEOPLE.empA, sessionId, 1, OPEN_TICKET);

    expect(r.status).toBe(409);
    const stored = api.db.get(CORE, sessionKey(sessionId))!;
    expect(stored["stateVersion"]).toBe(2);
    expect(stored["viewed"]).toEqual({ ticket: false, runbook: false, diagnostics: true }); // competitor's state intact
    expect(events()).toHaveLength(1); // our event was not written
  });

  it("the client can recover: after a 409, re-reading the version and retrying succeeds", async () => {
    const { sessionId } = await startedSession(api);
    await act(api, PEOPLE.empA, sessionId, 1, OPEN_TICKET);
    const stale = await act(api, PEOPLE.empA, sessionId, 1, OPEN_RUNBOOK);
    expect(stale.status).toBe(409);

    const fresh = (await getSession(PEOPLE.empA, sessionId)).body.session.stateVersion;
    const retry = await act(api, PEOPLE.empA, sessionId, fresh, OPEN_RUNBOOK);
    expect(retry.status).toBe(200);
    expect(retry.body.session.stateVersion).toBe(3);
  });

  it("a duplicate delivery of an already-applied request does not apply twice", async () => {
    const { sessionId } = await startedSession(api);
    const first = await act(api, PEOPLE.empA, sessionId, 1, OPEN_TICKET);
    const duplicate = await act(api, PEOPLE.empA, sessionId, 1, OPEN_TICKET);
    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(409);
    expect(events()).toHaveLength(2);
  });

  it("is atomic: a storage failure leaves state and events untouched", async () => {
    const { sessionId } = await startedSession(api);
    api.db.fail = (cmd) => (cmd === "TransactWrite" ? new Error("simulated outage") : null);
    const r = await act(api, PEOPLE.empA, sessionId, 1, OPEN_TICKET);

    expect(r.status).toBe(500);
    expect(api.db.get(CORE, sessionKey(sessionId))).toMatchObject({ stateVersion: 1, viewed: { ticket: false } });
    expect(events()).toHaveLength(1);
  });
});

describe("POST actions: invalid transitions and invalid input", () => {
  it.each([
    ["an unknown ticket id", { type: "OPEN_TICKET", ticketId: "INC-999" }],
    ["a runbook id used as a ticket id", { type: "OPEN_TICKET", ticketId: "RB-CHECKOUT-TIMEOUT" }],
    ["an unknown runbook id", { type: "OPEN_RUNBOOK", runbookId: "RB-NOPE" }],
    ["an unknown diagnostics id", { type: "OPEN_DIAGNOSTICS", diagnosticsId: "DIAG-NOPE" }],
  ])("rejects %s with 422 and records nothing", async (_label, action) => {
    const { sessionId } = await startedSession(api);
    const r = await act(api, PEOPLE.empA, sessionId, 1, action);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("UNKNOWN_OBJECT");
    expect(events()).toHaveLength(1);
    expect(api.db.get(CORE, sessionKey(sessionId))!["stateVersion"]).toBe(1);
  });

  it("rejects actions on a session that was never started (invalid transition), even if one exists in storage", async () => {
    const { sessionId } = await startedSession(api);
    api.db.put(CORE, { ...api.db.get(CORE, sessionKey(sessionId))!, phase: "NOT_STARTED", stateVersion: 0 });
    const r = await act(api, PEOPLE.empA, sessionId, 0, OPEN_TICKET);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("INVALID_TRANSITION");
  });

  it("enforces the per-session action cap with 429", async () => {
    const { sessionId } = await startedSession(api);
    api.db.put(CORE, { ...api.db.get(CORE, sessionKey(sessionId))!, stateVersion: 200 });
    const r = await act(api, PEOPLE.empA, sessionId, 200, OPEN_TICKET);
    expect(r.status).toBe(429);
    expect(r.body.code).toBe("LIMIT_REACHED");
  });

  it.each([
    ["START_INVESTIGATION (only the start endpoint may start)", { type: "START_INVESTIGATION" }],
    ["SAVE_CONFIG (not available in this slice)", { type: "SAVE_CONFIG", config: { request_timeout_ms: 1800 } }],
    ["SUBMIT_REPORT (not available in this slice)", { type: "SUBMIT_REPORT" }],
    ["an unknown action type", { type: "DELETE_EVERYTHING" }],
    ["an action with extra fields", { type: "OPEN_TICKET", ticketId: "INC-104", phase: "DONE" }],
  ])("rejects %s with 400", async (_label, action) => {
    const { sessionId } = await startedSession(api);
    const r = await act(api, PEOPLE.empA, sessionId, 1, action);
    expect(r.status).toBe(400);
    expect(events()).toHaveLength(1);
  });

  it.each([
    ["a forged phase", { phase: "DONE" }],
    ["a forged status", { status: "APPROVED" }],
    ["a forged passed flag", { passed: true }],
    ["a forged role", { role: "org_admin" }],
    ["a forged config", { config: { request_timeout_ms: 1 } }],
    ["a forged employee", { employeeSub: "someone-else" }],
  ])("rejects a request carrying %s", async (_label, extra) => {
    const { sessionId } = await startedSession(api);
    const r = await api.call({
      route: R.action, as: PEOPLE.empA, params: { sessionId },
      body: { expectedStateVersion: 1, action: OPEN_TICKET, ...extra },
    });
    expect(r.status).toBe(400);
    expect(api.db.get(CORE, sessionKey(sessionId))!["stateVersion"]).toBe(1);
  });

  it.each([
    ["a negative version", { expectedStateVersion: -1, action: OPEN_TICKET }],
    ["a fractional version", { expectedStateVersion: 1.5, action: OPEN_TICKET }],
    ["a string version", { expectedStateVersion: "1", action: OPEN_TICKET }],
    ["a missing version", { action: OPEN_TICKET }],
    ["a missing action", { expectedStateVersion: 1 }],
  ])("rejects %s", async (_label, body) => {
    const { sessionId } = await startedSession(api);
    const r = await api.call({ route: R.action, as: PEOPLE.empA, params: { sessionId }, body });
    expect(r.status).toBe(400);
  });

  it("rejects an empty, malformed or oversized body", async () => {
    const { sessionId } = await startedSession(api);
    const p = { route: R.action, as: PEOPLE.empA, params: { sessionId } } as const;
    expect((await api.call(p)).status).toBe(400);
    expect((await api.call({ ...p, rawBody: "{oops" })).status).toBe(400);
    expect((await api.call({ ...p, rawBody: JSON.stringify({ pad: "x".repeat(5000) }) })).status).toBe(413);
  });
});

describe("POST actions: who may act", () => {
  it.each([
    ["another employee on the same team", PEOPLE.empA2],
    ["an employee on another team", PEOPLE.empB],
    ["the assigning manager", PEOPLE.mgrA],
    ["an org admin", PEOPLE.admin],
    ["an employee of another organization", PEOPLE.otherEmp],
    ["an unknown user", "ghost-sub"],
  ])("denies %s with an opaque 404 and changes nothing", async (_label, who) => {
    const { sessionId } = await startedSession(api);
    const before = JSON.stringify([api.db.all(CORE), events()]);
    const r = await act(api, who, sessionId, 1, OPEN_TICKET);
    expect(r.status).toBe(404);
    expect(JSON.stringify([api.db.all(CORE), events()])).toBe(before);
  });

  it("denies the owner after their membership is suspended", async () => {
    const { sessionId } = await startedSession(api);
    seedMember(api.db, { ...PEOPLE.empA, status: "SUSPENDED" });
    expect((await act(api, PEOPLE.empA, sessionId, 1, OPEN_TICKET)).status).toBe(404);
  });

  it("requires authentication (no authorizer, or an ID token)", async () => {
    const { sessionId } = await startedSession(api);
    const body = { expectedStateVersion: 1, action: OPEN_TICKET };
    expect((await api.call({ route: R.action, noAuthorizer: true, params: { sessionId }, body })).status).toBe(401);
    expect((await api.call({ route: R.action, as: PEOPLE.empA, tokenUse: "id", params: { sessionId }, body })).status).toBe(401);
  });

  it("does not evaluate the action for a non-owner: a wrong version yields 404, not a 409 that leaks state", async () => {
    const { sessionId } = await startedSession(api);
    const r = await act(api, PEOPLE.empA2, sessionId, 12345, OPEN_TICKET);
    expect(r.status).toBe(404);
    expect(r.raw).not.toMatch(/version/i);
  });
});
