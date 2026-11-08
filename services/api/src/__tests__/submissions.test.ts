/**
 * Phase 2D-1: frozen incident submission.
 *
 * REAL router, routes, authorization, engine and runner handler against an in-memory DynamoDB.
 * These are local simulation tests; they say nothing about real DynamoDB, IAM or the deployed UI.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configHash } from "@onboardos/scenario-engine";
import { RunnerInvokeError } from "../runner.js";
import { buildLedgerRecord } from "../records.js";
import {
  CORE,
  EVENTS,
  PEOPLE,
  R,
  REPORT,
  assign,
  createApi,
  newKey,
  readyToSubmit,
  runTests,
  saveConfig,
  startAs,
  submitReport,
  type Api,
} from "./harness.js";

let api: Api;
let sessionId: string;
let assignmentId: string;
let runId: string;

const get = (pk: string, sk: string) => api.db.get(CORE, { PK: pk, SK: sk });
const sessionItem = () => get(`SESSION#${sessionId}`, "STATE")!;
const assignmentItem = () => get(`ASSIGN#${assignmentId}`, "META")!;
const submissionItems = () => api.db.all(CORE).filter((i) => i["entityType"] === "SUBMISSION");
const ledgerItems = () => api.db.all(CORE).filter((i) => i["entityType"] === "IDEMPOTENCY");
const eventsOf = (id = sessionId) =>
  api.db.all(EVENTS).filter((e) => e["PK"] === `SESSION#${id}`).sort((a, b) => String(a["SK"]).localeCompare(String(b["SK"])));
const snapshot = () => JSON.stringify([api.db.all(CORE), api.db.all(EVENTS)]);
const version = () => sessionItem()["stateVersion"] as number;

beforeEach(async () => {
  api = createApi();
  ({ sessionId, assignmentId, runId } = await readyToSubmit(api, 1800));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------

describe("successful submission", () => {
  it("freezes the report and the exact evidence, locks the attempt and moves the assignment to AWAITING_REVIEW", async () => {
    const before = version();
    const res = await submitReport(api, PEOPLE.empA, sessionId);
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);

    const sub = res.body.submission;
    expect(sub).toMatchObject({
      attemptNumber: 1,
      sessionId,
      assignmentId,
      organizationId: "northstar-cloud",
      scenarioId: "inc-104",
      scenarioVersion: 1,
      rubricVersion: 1,
      manifestVersion: 1,
      report: REPORT,
      config: { revision: 1, configHash: configHash({ request_timeout_ms: 1800 }), snapshot: { request_timeout_ms: 1800 } },
      evaluation: { status: "NOT_CONFIGURED" },
      review: null,
      evidence: { eventSequence: before + 1 },
      investigation: { ticketOpened: false, runbookOpened: false, diagnosticsOpened: false },
    });
    expect(sub.submissionId).toMatch(/^sub_01_[0-9a-f]{32}$/);
    expect(sub.testRun).toMatchObject({
      testRunId: runId, status: "PASSED", passedCount: 5, totalCount: 5, suiteVersion: 1, configRevision: 1,
      executor: { kind: "AWS_LAMBDA", runnerRequestId: "runner-req-1", invokeRequestId: "invoke-req-1" },
    });
    expect(sub.testRun).not.toHaveProperty("current");
    expect(sub.testRun).not.toHaveProperty("stale");

    // authoritative state moved exactly once
    expect(res.body.session).toMatchObject({ phase: "SUBMITTED", stateVersion: before + 1, attemptNumber: 1 });
    expect(res.body.session.submission.submissionId).toBe(sub.submissionId);
    expect(sessionItem()).toMatchObject({ phase: "SUBMITTED", stateVersion: before + 1, submissionId: sub.submissionId });
    expect(assignmentItem()).toMatchObject({ status: "AWAITING_REVIEW", latestSubmissionId: sub.submissionId, sessionId });
    // stored immutable item + ledger + exactly one matching event
    expect(submissionItems()).toHaveLength(1);
    expect(submissionItems()[0]).toMatchObject({ PK: `ASSIGN#${assignmentId}`, SK: "SUBMISSION#01", employeeSub: PEOPLE.empA.sub });
    expect(ledgerItems()).toHaveLength(1);
    const last = eventsOf().at(-1)!;
    expect(last).toMatchObject({ type: "SUBMISSION_CREATED", stateVersion: before + 1, actorSub: PEOPLE.empA.sub });
    expect(eventsOf()).toHaveLength(before + 1);
  });

  it("a FAILED terminal run is accepted and labelled FAILED -- honest evidence, not a resolution", async () => {
    const f = createApi();
    const r = await readyToSubmit(f, 1400);
    expect(r.run.body.testRun.status).toBe("FAILED");
    const res = await submitReport(f, PEOPLE.empA, r.sessionId);
    expect(res.status).toBe(201);
    expect(res.body.submission.testRun).toMatchObject({ status: "FAILED", passedCount: 4, totalCount: 5 });
    expect(res.body.session.submissions[0]).toMatchObject({ testStatus: "FAILED" });
  });

  it("the 800 ms baseline (revision 0) can be submitted as failed evidence", async () => {
    const f = createApi();
    const r = await readyToSubmit(f, 800);
    const res = await submitReport(f, PEOPLE.empA, r.sessionId);
    expect(res.status).toBe(201);
    expect(res.body.submission).toMatchObject({ config: { revision: 0 }, testRun: { status: "FAILED", configRevision: 0 } });
  });

  it("records what the employee actually opened, from server state", async () => {
    await api.call({ route: R.action, as: PEOPLE.empA, params: { sessionId }, body: { expectedStateVersion: version(), action: { type: "OPEN_TICKET", ticketId: "INC-104" } } });
    // opening an item changes the version; the earlier run is still current (config unchanged)
    const res = await submitReport(api, PEOPLE.empA, sessionId);
    expect(res.status).toBe(201);
    expect(res.body.submission.investigation).toEqual({ ticketOpened: true, runbookOpened: false, diagnosticsOpened: false });
  });

  it("the frozen evidence is independent of everything that happens afterwards", async () => {
    const res = await submitReport(api, PEOPLE.empA, sessionId);
    const frozen = structuredClone(submissionItems()[0]);
    // none of these can change it (they are all rejected, which is asserted elsewhere)
    await saveConfig(api, PEOPLE.empA, sessionId, version(), 900);
    await runTests(api, PEOPLE.empA, sessionId, version());
    expect(submissionItems()[0]).toEqual(frozen);
    const again = await api.call({ route: R.session, as: PEOPLE.empA, params: { sessionId } });
    expect(again.body.session.submission).toEqual({ ...res.body.submission });
  });

  it("never exposes suite identity, thresholds, internal ids or the employee's subject id", async () => {
    const res = await submitReport(api, PEOPLE.empA, sessionId);
    expect(res.raw).not.toMatch(/inc-104-checkout-timeout|suiteId|entityType|"PK"|savedBySub|requestedBySub|employeeSub|requestHash/i);
    expect(res.raw).not.toContain(PEOPLE.empA.sub);
    expect(res.raw).not.toContain(PEOPLE.mgrA.sub);
    expect(JSON.stringify(res.body.submission.testRun.cases)).not.toMatch(/1200|1600|threshold|expected|minimum/i);
  });
});

// ---------------------------------------------------------------------------

describe("evidence eligibility", () => {
  it("rejects when no test has ever been run", async () => {
    const f = createApi();
    const a = await assign(f, PEOPLE.mgrA, PEOPLE.empA);
    const s = await startAs(f, PEOPLE.empA, a.body.assignment.assignmentId);
    const before = JSON.stringify([f.db.all(CORE), f.db.all(EVENTS)]);
    const res = await submitReport(f, PEOPLE.empA, s.body.session.sessionId);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("EVIDENCE_NOT_CURRENT");
    expect(JSON.stringify([f.db.all(CORE), f.db.all(EVENTS)])).toBe(before);
  });

  it("rejects a STALE result: the config changed after the run", async () => {
    await saveConfig(api, PEOPLE.empA, sessionId, version(), 1500);
    const before = snapshot();
    const res = await submitReport(api, PEOPLE.empA, sessionId, { testRunId: runId, configRevision: 1, configHash: configHash({ request_timeout_ms: 1800 }) });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("EVIDENCE_NOT_CURRENT");
    expect(snapshot()).toBe(before);
    expect(submissionItems()).toHaveLength(0);
  });

  it("is accepted again once the changed configuration has been tested", async () => {
    await saveConfig(api, PEOPLE.empA, sessionId, version(), 1500);
    await runTests(api, PEOPLE.empA, sessionId, version());
    const res = await submitReport(api, PEOPLE.empA, sessionId);
    expect(res.status).toBe(201);
    expect(res.body.submission.config.revision).toBe(2);
  });

  it("rejects while a test run is PENDING (409 RUN_IN_PROGRESS)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    api.useRunner({ invoke: async () => { await gate; throw new RunnerInvokeError("RUNNER_TIMEOUT"); } });
    const pending = runTests(api, PEOPLE.empA, sessionId, version());
    await vi.waitFor(() => expect(api.runnerCalls.length).toBeGreaterThan(1));
    const before = snapshot();
    const res = await submitReport(api, PEOPLE.empA, sessionId, { key: newKey() });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("RUN_IN_PROGRESS");
    expect(snapshot()).toBe(before);
    release();
    await pending;
  });

  it("rejects ERROR evidence (the runner produced no results) and accepts after a successful re-run", async () => {
    api.useRunner({ invoke: async () => { throw new RunnerInvokeError("RUNNER_TIMEOUT"); } });
    const errored = await runTests(api, PEOPLE.empA, sessionId, version());
    expect(errored.body.testRun.status).toBe("ERROR");
    const res = await submitReport(api, PEOPLE.empA, sessionId);
    // The ERROR run is on the same revision, so it is the newest current run: it must not be skipped
    // in favour of the older PASSED run.
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("EVIDENCE_NOT_COMPLETED");
    expect(submissionItems()).toHaveLength(0);

    api.useRunner((await import("./harness.js")).inProcessRunner());
    await runTests(api, PEOPLE.empA, sessionId, version());
    expect((await submitReport(api, PEOPLE.empA, sessionId)).status).toBe(201);
  });
});

describe("forged or cross-session evidence", () => {
  it.each([
    ["a made-up run id", (c: any) => ({ testRunId: "run_0099_aaaaaaaaaaaa", configRevision: c.rev, configHash: c.hash })],
    ["another revision number", (c: any) => ({ testRunId: c.runId, configRevision: 7, configHash: c.hash })],
    ["a hash for a different configuration", (c: any) => ({ testRunId: c.runId, configRevision: c.rev, configHash: configHash({ request_timeout_ms: 2000 }) })],
    ["an all-zero hash", (c: any) => ({ testRunId: c.runId, configRevision: c.rev, configHash: "sha256:" + "0".repeat(64) })],
  ])("rejects %s (409 EVIDENCE_MISMATCH) and changes nothing", async (_n, make) => {
    const before = snapshot();
    const res = await submitReport(api, PEOPLE.empA, sessionId, make({ runId, rev: 1, hash: configHash({ request_timeout_ms: 1800 }) }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EVIDENCE_MISMATCH");
    expect(snapshot()).toBe(before);
  });

  it("rejects another employee's run id presented as this session's evidence", async () => {
    const other = await readyToSubmit(api, 1800, PEOPLE.empA2);
    const before = snapshot();
    const res = await submitReport(api, PEOPLE.empA, sessionId, { testRunId: other.runId });
    // Run ids are derived from the session id, so another session's run id can never be this one's evidence.
    expect(other.runId).not.toBe(runId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EVIDENCE_MISMATCH");
    expect(snapshot()).toBe(before);
    expect(submissionItems().every((s) => s["sessionId"] === sessionId)).toBe(true);
  });

  it.each([
    ["status", { status: "PASSED" }],
    ["passed", { passed: true }],
    ["submissionId", { submissionId: "sub_01_" + "a".repeat(32) }],
    ["employeeSub", { employeeSub: PEOPLE.mgrA.sub }],
    ["attemptNumber", { attemptNumber: 9 }],
    ["rubricVersion", { rubricVersion: 5 }],
    ["testRun", { testRun: { status: "PASSED" } }],
    ["config", { config: { request_timeout_ms: 2000 } }],
    ["evaluation", { evaluation: { status: "COMPLETE" } }],
  ])("a forged %s field is a 400 and nothing is written", async (_n, extra) => {
    const before = snapshot();
    const res = await submitReport(api, PEOPLE.empA, sessionId, { extra });
    expect(res.status).toBe(400);
    expect(snapshot()).toBe(before);
  });
});

describe("request validation", () => {
  it.each([
    ["missing", null],
    ["too short", "short"],
    ["too long", "x".repeat(65)],
    ["illegal characters", "bad key with spaces!"],
  ])("requires a well-formed Idempotency-Key (%s)", async (_n, key) => {
    const before = snapshot();
    const res = await submitReport(api, PEOPLE.empA, sessionId, { key });
    expect(res.status).toBe(400);
    expect(snapshot()).toBe(before);
  });

  const field = (over: Record<string, unknown>) => ({ ...REPORT, ...over });
  it.each([
    ["an empty field", field({ rootCause: "" })],
    ["a whitespace-only field", field({ verification: " ".repeat(40) })],
    ["a too-short field", field({ correctiveAction: "fix it" })],
    ["a too-long field", field({ remainingRisks: "r".repeat(1501) })],
    ["a missing field", (() => { const { remainingRisks: _x, ...rest } = REPORT; return rest; })()],
    ["an unknown field", field({ score: 100 })],
    ["a non-string field", field({ rootCause: 12345678901 })],
  ])("rejects a report with %s", async (_n, report) => {
    const before = snapshot();
    const res = await submitReport(api, PEOPLE.empA, sessionId, { report });
    expect(res.status).toBe(400);
    expect(snapshot()).toBe(before);
  });

  it("accepts text at exactly the limits and stores it trimmed", async () => {
    const res = await submitReport(api, PEOPLE.empA, sessionId, {
      report: { rootCause: `  ${"a".repeat(1500)}  `, correctiveAction: "b".repeat(10), verification: "c".repeat(10), remainingRisks: "d".repeat(10) },
    });
    expect(res.status).toBe(201);
    expect(res.body.submission.report.rootCause).toHaveLength(1500);
  });

  it("accepts a maximal report (4 x 1500 multi-byte characters) under the route's body limit", async () => {
    const wide = "é".repeat(1500);
    const res = await submitReport(api, PEOPLE.empA, sessionId, { report: { rootCause: wide, correctiveAction: wide, verification: wide, remainingRisks: wide } });
    expect(res.status).toBe(201);
  });

  it("rejects an oversized body with 413", async () => {
    const res = await api.call({
      route: R.submit, as: PEOPLE.empA, params: { sessionId }, headers: { "idempotency-key": newKey() },
      rawBody: JSON.stringify({ pad: "p".repeat(20000) }),
    });
    expect(res.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------

describe("idempotency and duplicate protection", () => {
  it("the same request with the same key returns the original submission and creates nothing new", async () => {
    const key = newKey();
    const first = await submitReport(api, PEOPLE.empA, sessionId, { key });
    expect(first.status).toBe(201);
    const after = snapshot();

    const retry = await submitReport(api, PEOPLE.empA, sessionId, { key });
    expect(retry.status).toBe(200);
    expect(retry.body.created).toBe(false);
    expect(retry.body.submission).toEqual(first.body.submission);
    expect(snapshot()).toBe(after);
    expect(submissionItems()).toHaveLength(1);
    expect(eventsOf().filter((e) => e["type"] === "SUBMISSION_CREATED")).toHaveLength(1);
  });

  it("a retry still works with a refreshed version, and long after the manager has decided", async () => {
    const key = newKey();
    const first = await submitReport(api, PEOPLE.empA, sessionId, { key });
    const retry = await submitReport(api, PEOPLE.empA, sessionId, { key, expectedStateVersion: 999 });
    expect(retry.status).toBe(200);
    expect(retry.body.submission.submissionId).toBe(first.body.submission.submissionId);
  });

  it("reusing a key for DIFFERENT content is refused and the original stays untouched", async () => {
    const key = newKey();
    await submitReport(api, PEOPLE.empA, sessionId, { key });
    const stored = structuredClone(submissionItems()[0]);
    const res = await submitReport(api, PEOPLE.empA, sessionId, { key, report: { ...REPORT, rootCause: "A completely different root cause." } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(submissionItems()[0]).toEqual(stored);
  });

  it("a second submission of an already-submitted attempt (new key) is 409 ALREADY_SUBMITTED", async () => {
    await submitReport(api, PEOPLE.empA, sessionId);
    const after = snapshot();
    const res = await submitReport(api, PEOPLE.empA, sessionId, { key: newKey() });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ALREADY_SUBMITTED");
    expect(snapshot()).toBe(after);
  });

  it("two simultaneous submissions with different keys: exactly one authoritative transition", async () => {
    const [a, b] = await Promise.all([
      submitReport(api, PEOPLE.empA, sessionId, { key: newKey() }),
      submitReport(api, PEOPLE.empA, sessionId, { key: newKey() }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(submissionItems()).toHaveLength(1);
    expect(ledgerItems()).toHaveLength(1);
    expect(eventsOf().filter((e) => e["type"] === "SUBMISSION_CREATED")).toHaveLength(1);
    expect(assignmentItem()["status"]).toBe("AWAITING_REVIEW");
  });

  it("two simultaneous submissions with the SAME key: one creates, the other replays the original", async () => {
    const key = newKey();
    const [a, b] = await Promise.all([
      submitReport(api, PEOPLE.empA, sessionId, { key }),
      submitReport(api, PEOPLE.empA, sessionId, { key }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.submission.submissionId).toBe(b.body.submission.submissionId);
    expect(submissionItems()).toHaveLength(1);
    expect(eventsOf().filter((e) => e["type"] === "SUBMISSION_CREATED")).toHaveLength(1);
  });

  it("a stale expectedStateVersion on a fresh key is a 409 VERSION_CONFLICT with nothing written", async () => {
    const before = snapshot();
    const res = await submitReport(api, PEOPLE.empA, sessionId, { expectedStateVersion: version() - 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("VERSION_CONFLICT");
    expect(snapshot()).toBe(before);
  });
});

describe("transaction failure and races", () => {
  it("a storage failure commits nothing, and the same request can then be retried successfully", async () => {
    const key = newKey();
    const before = snapshot();
    api.db.fail = (cmd) => (cmd === "TransactWrite" ? new Error("simulated outage") : null);
    const failed = await submitReport(api, PEOPLE.empA, sessionId, { key });
    api.db.fail = null;
    expect(failed.status).toBe(500);
    expect(snapshot()).toBe(before);
    expect(submissionItems()).toHaveLength(0);
    expect(ledgerItems()).toHaveLength(0);

    const retried = await submitReport(api, PEOPLE.empA, sessionId, { key });
    expect(retried.status).toBe(201);
    expect(submissionItems()).toHaveLength(1);
  });

  it("a competing write between read and write cancels the whole transaction (409)", async () => {
    let fired = false;
    api.db.beforeTransact = () => {
      if (fired) return;
      fired = true;
      api.db.put(CORE, { ...sessionItem(), stateVersion: version() + 1 });
    };
    const res = await submitReport(api, PEOPLE.empA, sessionId);
    expect(res.status).toBe(409);
    expect(submissionItems()).toHaveLength(0);
    expect(ledgerItems()).toHaveLength(0);
    expect(assignmentItem()["status"]).toBe("IN_PROGRESS");
  });

  it("the assignment transition is part of the same transaction: if it cannot apply, nothing is committed", async () => {
    let fired = false;
    api.db.beforeTransact = () => {
      if (fired) return;
      fired = true;
      api.db.put(CORE, { ...assignmentItem(), status: "APPROVED" }); // changed under us, version unchanged
    };
    const res = await submitReport(api, PEOPLE.empA, sessionId);
    expect(res.status).not.toBe(201);
    expect(submissionItems()).toHaveLength(0);
    expect(sessionItem()["phase"]).toBe("INVESTIGATING");
  });

  it("an existing submission for the attempt is never overwritten, even if state were rolled back", async () => {
    await submitReport(api, PEOPLE.empA, sessionId, { key: newKey() });
    const frozen = structuredClone(submissionItems()[0]);
    // simulate corruption/rollback of the mutable records only
    api.db.put(CORE, { ...sessionItem(), phase: "INVESTIGATING", submissionId: null, stateVersion: version() });
    api.db.put(CORE, { ...assignmentItem(), status: "IN_PROGRESS" });
    const res = await submitReport(api, PEOPLE.empA, sessionId, { key: newKey(), report: { ...REPORT, rootCause: "Attempting to overwrite the frozen evidence with new text." } });
    expect(res.status).not.toBe(201);
    expect(submissionItems()).toHaveLength(1);
    expect(submissionItems()[0]).toEqual(frozen);
  });

  it("refuses when the assignment is no longer this employee's open attempt on this session", async () => {
    api.db.put(CORE, { ...assignmentItem(), status: "APPROVED" });
    const res = await submitReport(api, PEOPLE.empA, sessionId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_ASSIGNMENT_STATE");
    expect(submissionItems()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("a submitted attempt is locked, but earlier history stays readable", () => {
  beforeEach(async () => {
    await saveConfig(api, PEOPLE.empA, sessionId, version(), 1500); // add history before submitting
    await runTests(api, PEOPLE.empA, sessionId, version());
    expect((await submitReport(api, PEOPLE.empA, sessionId)).status).toBe(201);
  });

  it("rejects saving config, running tests, opening items and re-submitting; nothing changes", async () => {
    const before = snapshot();
    const v = version();
    expect((await saveConfig(api, PEOPLE.empA, sessionId, v, 900)).status).toBe(422);
    expect((await runTests(api, PEOPLE.empA, sessionId, v)).status).toBe(422);
    const open = await api.call({ route: R.action, as: PEOPLE.empA, params: { sessionId }, body: { expectedStateVersion: v, action: { type: "OPEN_RUNBOOK", runbookId: "RB-CHECKOUT-TIMEOUT" } } });
    expect(open.status).toBe(422);
    expect((await submitReport(api, PEOPLE.empA, sessionId, { key: newKey() })).status).toBe(409);
    expect(snapshot()).toBe(before);
    expect(api.runnerCalls).toHaveLength(2); // the two runs made before submitting; none after the lock
  });

  it("keeps every revision and test run readable, newest first", async () => {
    const s = (await api.call({ route: R.session, as: PEOPLE.empA, params: { sessionId } })).body.session;
    expect(s.phase).toBe("SUBMITTED");
    expect(s.revisions.map((r: any) => r.revision)).toEqual([2, 1]);
    expect(s.testRuns).toHaveLength(2);
    expect(s.activeTestRunId).toBeNull();
    expect(s.submission.config.revision).toBe(2);
    expect(s.submissions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("who may submit", () => {
  it.each([
    ["another employee", PEOPLE.empA2],
    ["an employee in another team", PEOPLE.empB],
    ["the assigning manager", PEOPLE.mgrA],
    ["another manager", PEOPLE.mgrB],
    ["an org admin", PEOPLE.admin],
    ["a user from another organization", PEOPLE.otherEmp],
    ["an unknown user", "ghost-sub"],
  ])("%s gets an opaque 404 and nothing is written", async (_n, who) => {
    const before = snapshot();
    const res = await api.call({
      route: R.submit, as: who, params: { sessionId }, headers: { "idempotency-key": newKey() },
      body: { expectedStateVersion: version(), testRunId: runId, configRevision: 1, configHash: configHash({ request_timeout_ms: 1800 }), report: REPORT },
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(snapshot()).toBe(before);
  });

  it("an unauthenticated request is refused", async () => {
    const res = await api.call({ route: R.submit, noAuthorizer: true, params: { sessionId }, body: {}, headers: { "idempotency-key": newKey() } });
    expect(res.status).toBe(401);
  });

  it("a suspended employee can no longer submit", async () => {
    const m = api.db.get(CORE, { PK: "ORG#northstar-cloud", SK: `MEMBER#${PEOPLE.empA.sub}` })!;
    api.db.put(CORE, { ...m, status: "SUSPENDED" });
    const res = await submitReport(api, PEOPLE.empA, sessionId);
    expect(res.status).toBe(404);
    expect(submissionItems()).toHaveLength(0);
  });

  it("an idempotency key from another employee's session cannot replay or reveal their submission", async () => {
    const other = await readyToSubmit(api, 1800, PEOPLE.empA2);
    const key = newKey();
    expect((await submitReport(api, PEOPLE.empA2, other.sessionId, { key })).status).toBe(201);
    // empA reuses empA2's key on their own session: it is scoped to the session, so it is a fresh key
    const mine = await submitReport(api, PEOPLE.empA, sessionId, { key });
    expect(mine.status).toBe(201);
    expect(mine.body.submission.sessionId).toBe(sessionId);
  });
});

describe("compatibility with records written before Phase 2D", () => {
  it("a Phase 2C session and assignment (no attempt/submission fields) can be submitted as attempt 1", async () => {
    const s = { ...sessionItem() };
    for (const k of ["attemptNumber", "submissionId", "reviewDecision"]) delete (s as any)[k];
    api.db.put(CORE, s);
    const a = { ...assignmentItem() };
    for (const k of ["attemptNumber", "latestSubmissionId"]) delete (a as any)[k];
    api.db.put(CORE, a);

    const view = await api.call({ route: R.session, as: PEOPLE.empA, params: { sessionId } });
    expect(view.body.session).toMatchObject({ attemptNumber: 1, submission: null, submissions: [] });
    const res = await submitReport(api, PEOPLE.empA, sessionId);
    expect(res.status).toBe(201);
    expect(res.body.submission.attemptNumber).toBe(1);
    expect(assignmentItem()).toMatchObject({ status: "AWAITING_REVIEW" });
  });

  it("a tampered submission (PASSED with a failing case) is never displayed", async () => {
    const res = await submitReport(api, PEOPLE.empA, sessionId);
    const stored = submissionItems()[0] as any;
    const bad = structuredClone(stored);
    bad.testRun.cases[0].status = "FAIL"; // PASSED but a case fails
    api.db.put(CORE, bad);
    const view = await api.call({ route: R.session, as: PEOPLE.empA, params: { sessionId } });
    expect(view.body.session.submission).toBeNull();
    expect(view.body.session.submissions).toHaveLength(0);
    expect(view.raw).not.toContain(res.body.submission.submissionId);
  });
});

// ---------------------------------------------------------------------------

describe("transaction conditions hold under races (defence in depth beyond the app-level checks)", () => {
  it("a ledger entry that appears for the same key just before commit is never overwritten", async () => {
    const key = newKey();
    let fired = false;
    api.db.beforeTransact = () => {
      if (fired) return;
      fired = true;
      // someone else's request with this key committed its ledger entry (no state change visible yet)
      api.db.put(CORE, buildLedgerRecord(sessionId, key, "f".repeat(64), "sub_01_" + assignmentId.slice(4), api.deps.now()) as Record<string, unknown>);
    };
    const res = await submitReport(api, PEOPLE.empA, sessionId, { key });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(submissionItems()).toHaveLength(0);
    expect(ledgerItems()).toHaveLength(1);
    expect(ledgerItems()[0]!["requestHash"]).toBe("f".repeat(64));
  });

  it("the assignment pointing at another session at commit time cancels the submission", async () => {
    let fired = false;
    api.db.beforeTransact = () => {
      if (fired) return;
      fired = true;
      api.db.put(CORE, { ...assignmentItem(), sessionId: "ses_" + "e".repeat(32) });
    };
    const res = await submitReport(api, PEOPLE.empA, sessionId);
    expect(res.status).not.toBe(201);
    expect(submissionItems()).toHaveLength(0);
    expect(sessionItem()["phase"]).toBe("INVESTIGATING");
  });

  it("the assignment pointing at another session BEFORE the request is refused up front", async () => {
    api.db.put(CORE, { ...assignmentItem(), sessionId: "ses_" + "e".repeat(32) });
    const res = await submitReport(api, PEOPLE.empA, sessionId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_ASSIGNMENT_STATE");
  });

  it("a PENDING run that the session does not know about still blocks submission", async () => {
    // session claims no active run, but the newest current run record is PENDING (inconsistent storage)
    const run = api.db.all(CORE).filter((i) => String(i["SK"]).startsWith("TEST#") && i["PK"] === `SESSION#${sessionId}`)[0]!;
    api.db.put(CORE, { ...run, status: "PENDING", completedAt: null, cases: [], passedCount: 0, totalCount: 0, executor: null });
    const res = await submitReport(api, PEOPLE.empA, sessionId, { testRunId: runId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("RUN_IN_PROGRESS");
    expect(submissionItems()).toHaveLength(0);
  });

  it("each of the asserted revision/hash is checked independently of the others", async () => {
    // right run id and revision, wrong hash
    const a = await submitReport(api, PEOPLE.empA, sessionId, { configHash: configHash({ request_timeout_ms: 1999 }) });
    expect(a.body.code).toBe("EVIDENCE_MISMATCH");
    // right run id and hash, wrong revision
    const b = await submitReport(api, PEOPLE.empA, sessionId, { configRevision: 5 });
    expect(b.body.code).toBe("EVIDENCE_MISMATCH");
    expect(submissionItems()).toHaveLength(0);
  });
});

describe("a tampered stored submission is never shown or reviewed", () => {
  const tamper = async (mutate: (s: any) => void) => {
    const res = await submitReport(api, PEOPLE.empA, sessionId);
    const bad = structuredClone(submissionItems()[0]) as any;
    mutate(bad);
    api.db.put(CORE, bad);
    const view = await api.call({ route: R.session, as: PEOPLE.empA, params: { sessionId } });
    const review = await api.call({ route: R.review, as: PEOPLE.mgrA, params: { submissionId: res.body.submission.submissionId } });
    return { view, review, id: res.body.submission.submissionId as string };
  };

  it.each([
    ["PASSED with a failing case and matching counts", (s: any) => { s.testRun.cases[0].status = "FAIL"; s.testRun.passedCount = 4; }],
    ["FAILED with every case passing", (s: any) => { s.testRun.status = "FAILED"; }],
    ["a config snapshot that no longer matches its hash", (s: any) => { s.config.snapshot.request_timeout_ms = 2000; }],
    ["a run bound to a different configuration hash", (s: any) => { s.testRun.configHash = configHash({ request_timeout_ms: 800 }); s.testRun.configSnapshot = { request_timeout_ms: 800 }; }],
    ["a run bound to a different revision", (s: any) => { s.config.revision = 9; }],
    ["an attempt number that does not match its key", (s: any) => { s.attemptNumber = 2; }],
    ["a missing execution reference", (s: any) => { s.testRun.executor = null; }],
  ])("%s", async (_n, mutate) => {
    const { view, review, id } = await tamper(mutate);
    expect(view.body.session.submission).toBeNull();
    expect(view.raw).not.toContain(id);
    expect([404, 500]).toContain(review.status); // fail closed; never rendered
    expect(review.raw).not.toContain("rootCause");
  });
});
