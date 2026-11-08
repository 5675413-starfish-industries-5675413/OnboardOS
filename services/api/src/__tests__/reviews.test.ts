/**
 * Phase 2D-2: manager review, immutable decisions and the revision-attempt workflow.
 *
 * REAL router, authorization, engine and runner handler against an in-memory DynamoDB.
 * Local simulation only: nothing here proves real DynamoDB, IAM, Cognito or the deployed UI.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canReview } from "../authz.js";
import { parseSubmissionId, submissionIdFor } from "../ids.js";
import { parseMember } from "../records.js";
import {
  CORE,
  EVENTS,
  ORG,
  OTHER_ORG,
  PEOPLE,
  R,
  decide,
  finishAttempt,
  getReview,
  readyToSubmit,
  startAs,
  submitReport,
  type Api,
  createApi,
} from "./harness.js";

let api: Api;
let sessionId: string;
let assignmentId: string;
let submissionId: string;

const FEEDBACK = "Please explain why 1400 ms was not enough and re-test with a higher timeout.";
const get = (pk: string, sk: string) => api.db.get(CORE, { PK: pk, SK: sk });
const assignmentItem = () => get(`ASSIGN#${assignmentId}`, "META")!;
const sessionItem = (id = sessionId) => get(`SESSION#${id}`, "STATE")!;
const decisionItems = () => api.db.all(CORE).filter((i) => i["entityType"] === "REVIEW_DECISION");
const submissionItems = () => api.db.all(CORE).filter((i) => i["entityType"] === "SUBMISSION");
const eventsOf = (id = sessionId) =>
  api.db.all(EVENTS).filter((e) => e["PK"] === `SESSION#${id}`).sort((a, b) => String(a["SK"]).localeCompare(String(b["SK"])));
const snapshot = () => JSON.stringify([api.db.all(CORE), api.db.all(EVENTS)]);
const sessionView = async (who = PEOPLE.empA, id = sessionId) =>
  (await api.call({ route: R.session, as: who, params: { sessionId: id } })).body.session;

beforeEach(async () => {
  api = createApi();
  ({ sessionId, assignmentId } = await readyToSubmit(api, 1400)); // a FAILED (partial) result: honest evidence
  submissionId = (await submitReport(api, PEOPLE.empA, sessionId)).body.submission.submissionId;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------

describe("the review bundle", () => {
  it("shows the assigning manager the frozen evidence, the real Lambda reference and the server-recorded timeline", async () => {
    const res = await getReview(api, PEOPLE.mgrA, submissionId);
    expect(res.status).toBe(200);
    const r = res.body.review;
    expect(r.employee).toEqual({ userSub: PEOPLE.empA.sub, displayName: "employee" });
    expect(r.assignment).toMatchObject({ assignmentId, status: "AWAITING_REVIEW", attemptNumber: 1, latestSubmissionId: submissionId });
    expect(r.canDecide).toBe(true);
    expect(r.submission).toMatchObject({
      submissionId, attemptNumber: 1, report: expect.objectContaining({ rootCause: expect.any(String) }),
      config: { revision: 1, snapshot: { request_timeout_ms: 1400 } },
      evaluation: { status: "NOT_CONFIGURED" }, review: null,
      testRun: { status: "FAILED", passedCount: 4, totalCount: 5, executor: { kind: "AWS_LAMBDA", runnerRequestId: "runner-req-1" } },
    });
    expect(r.history).toHaveLength(1);
    // The timeline is the session's real event stream, contiguous and ending with the submission.
    expect(r.timeline.map((e: any) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(r.timeline.map((e: any) => e.type)).toEqual([
      "INVESTIGATION_STARTED", "CONFIG_SAVED", "TEST_RUN_REQUESTED", "TEST_RUN_COMPLETED", "SUBMISSION_CREATED",
    ]);
    expect(r.timeline.map((e: any) => e.actor)).toEqual(["EMPLOYEE", "EMPLOYEE", "EMPLOYEE", "SYSTEM", "EMPLOYEE"]);
    expect(r.timeline[1].summary).toBe("Saved configuration revision 1 (request_timeout_ms 1400)");
    expect(r.timeline[3].summary).toBe("Test run finished: FAILED");
  });

  it("is read-only evidence: reading it writes nothing", async () => {
    const before = snapshot();
    await getReview(api, PEOPLE.mgrA, submissionId);
    await getReview(api, PEOPLE.mgrA, submissionId);
    expect(snapshot()).toBe(before);
  });

  it("an org admin of the same organization may read it", async () => {
    const res = await getReview(api, PEOPLE.admin, submissionId);
    expect(res.status).toBe(200);
    expect(res.body.review.canDecide).toBe(true);
  });

  it("does not leak the suite, infrastructure names, other people's subject ids or the manager's identity", async () => {
    const res = await getReview(api, PEOPLE.mgrA, submissionId);
    expect(res.raw).not.toMatch(/inc-104-checkout-timeout|suiteId|entityType|requestHash|assignedBySub|"PK"/i);
    expect(res.raw).not.toContain(PEOPLE.mgrA.sub);
    expect(res.raw).not.toContain(`${PEOPLE.empA.name}@secret.example`);
    expect(JSON.stringify(res.body.review.submission.testRun.cases)).not.toMatch(/1200|1600|threshold|expected|minimum/i);
  });

  it("the timeline is frozen at the submission: later events are not evidence", async () => {
    await decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" });
    const res = await getReview(api, PEOPLE.mgrA, submissionId);
    expect(res.body.review.timeline.at(-1).type).toBe("SUBMISSION_CREATED");
    expect(res.body.review.timeline.some((e: any) => e.type === "REVIEW_DECIDED")).toBe(false);
    expect(eventsOf().at(-1)).toMatchObject({ type: "REVIEW_DECIDED" }); // but the event exists
  });

  it("skips (and does not display) a malformed event record", async () => {
    api.db.put(EVENTS, { PK: `SESSION#${sessionId}`, SK: "SEQ#0000000003", type: 42 });
    const res = await getReview(api, PEOPLE.mgrA, submissionId);
    expect(res.status).toBe(200);
    expect(res.body.review.timeline.map((e: any) => e.sequence)).toEqual([1, 2, 4, 5]);
  });
});

describe("who may read or decide: ID guessing and cross-tenant access", () => {
  let foreign: { submissionId: string };

  beforeEach(async () => {
    // A second tenant with its own complete submission.
    const r = await readyToSubmit(api, 1800, PEOPLE.otherEmp, PEOPLE.otherMgr, OTHER_ORG);
    const sub = await submitReport(api, PEOPLE.otherEmp, r.sessionId);
    expect(sub.status).toBe(201);
    foreign = { submissionId: sub.body.submission.submissionId };
  });

  const denied = [
    ["the submitting employee", PEOPLE.empA],
    ["another employee", PEOPLE.empA2],
    ["an employee of another team", PEOPLE.empB],
    ["a manager who did not assign it", PEOPLE.mgrB],
    ["an unknown user", "ghost-sub"],
    ["another tenant's manager", PEOPLE.otherMgr],
    ["another tenant's employee", PEOPLE.otherEmp],
  ] as const;

  it.each(denied)("%s: read and decide are an opaque 404 and nothing changes", async (_n, who) => {
    const before = snapshot();
    const read = await getReview(api, who, submissionId);
    const dec = await decide(api, who, submissionId, { decision: "APPROVE" });
    expect([read.status, dec.status]).toEqual([404, 404]);
    expect(read.body.code).toBe("NOT_FOUND");
    expect(snapshot()).toBe(before);
  });

  it("a manager cannot reach another organization's submission, and theirs is unreachable from here", async () => {
    expect((await getReview(api, PEOPLE.mgrA, foreign.submissionId)).status).toBe(404);
    expect((await decide(api, PEOPLE.mgrA, foreign.submissionId, { decision: "APPROVE" })).status).toBe(404);
    expect((await getReview(api, PEOPLE.otherMgr, submissionId)).status).toBe(404);
    expect((await getReview(api, PEOPLE.otherMgr, foreign.submissionId)).status).toBe(200);
  });

  it("an org admin of another organization has no access", async () => {
    const outsider = { sub: "outside-admin-sub", role: "org_admin" as const, teams: [], name: "outsider", org: OTHER_ORG };
    api.db.put(CORE, { PK: `ORG#${OTHER_ORG}`, SK: `MEMBER#${outsider.sub}`, role: "org_admin", status: "ACTIVE", teamIds: [] });
    expect((await getReview(api, outsider.sub, submissionId)).status).toBe(404);
    expect((await decide(api, outsider.sub, submissionId, { decision: "APPROVE" })).status).toBe(404);
  });

  it("a suspended manager loses access", async () => {
    const m = api.db.get(CORE, { PK: `ORG#${ORG}`, SK: `MEMBER#${PEOPLE.mgrA.sub}` })!;
    api.db.put(CORE, { ...m, status: "SUSPENDED" });
    expect((await getReview(api, PEOPLE.mgrA, submissionId)).status).toBe(404);
  });

  it.each([
    ["not a submission id", "nope"],
    ["traversal", "../ASSIGN"],
    ["attempt 00", "sub_00_" + "a".repeat(32)],
    ["upper-case hex", "sub_01_" + "A".repeat(32)],
    ["well-formed but unknown assignment", "sub_01_" + "0".repeat(32)],
  ])("%s is a 404", async (_n, id) => {
    expect((await getReview(api, PEOPLE.mgrA, id)).status).toBe(404);
    expect((await decide(api, PEOPLE.mgrA, id, { decision: "APPROVE" })).status).toBe(404);
  });

  it("an attempt that has not been submitted does not exist for reviewers", async () => {
    const id = submissionId.replace("sub_01_", "sub_02_");
    expect((await getReview(api, PEOPLE.mgrA, id)).status).toBe(404);
    expect((await decide(api, PEOPLE.mgrA, id, { decision: "APPROVE" })).status).toBe(404);
  });

  it("unauthenticated requests are refused", async () => {
    const res = await api.call({ route: R.review, noAuthorizer: true, params: { submissionId } });
    expect(res.status).toBe(401);
    expect((await api.call({ route: R.decide, noAuthorizer: true, params: { submissionId }, body: { decision: "APPROVE" } })).status).toBe(401);
  });

  it("canReview: nobody reviews their own work, whatever their role", () => {
    const admin = parseMember({ PK: `ORG#${ORG}`, SK: "MEMBER#admin-sub", role: "org_admin", status: "ACTIVE", teamIds: [] })!;
    expect(canReview(admin, { organizationId: ORG, assignedBySub: "x", employeeSub: "admin-sub" })).toBe(false);
    expect(canReview(admin, { organizationId: ORG, assignedBySub: "x", employeeSub: "someone" })).toBe(true);
    expect(canReview(admin, { organizationId: "other", assignedBySub: "x", employeeSub: "someone" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("submission ids", () => {
  it("round-trip with their assignment and attempt, and reject anything malformed", () => {
    const asg = "asg_" + "a".repeat(32);
    expect(parseSubmissionId(submissionIdFor(asg, 3))).toEqual({ assignmentId: asg, attempt: 3 });
    for (const bad of ["", "sub_00_" + "a".repeat(32), "sub_1_" + "a".repeat(32), "sub_01_" + "a".repeat(31), "sub_01_" + "g".repeat(32), "SUB_01_" + "a".repeat(32)]) {
      expect(parseSubmissionId(bad), bad).toBeNull();
    }
  });
});

describe("decision transactions hold under races", () => {
  it("an assignment that left AWAITING_REVIEW at commit time cancels the decision", async () => {
    let fired = false;
    api.db.beforeTransact = () => {
      if (fired) return;
      fired = true;
      api.db.put(CORE, { ...assignmentItem(), status: "IN_PROGRESS" }); // session version untouched
    };
    const res = await decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" });
    expect(res.status).toBe(409);
    expect(decisionItems()).toHaveLength(0);
    expect(assignmentItem()["status"]).toBe("IN_PROGRESS");
  });

  it("a decision item that appears just before commit is never overwritten", async () => {
    let fired = false;
    api.db.beforeTransact = () => {
      if (fired) return;
      fired = true;
      api.db.put(CORE, {
        PK: `ASSIGN#${assignmentId}`, SK: "DECISION#01", entityType: "REVIEW_DECISION", submissionId, assignmentId,
        attemptNumber: 1, sessionId, organizationId: ORG, decision: "REQUEST_REVISION", feedback: "Earlier decision from someone else.",
        reviewerSub: PEOPLE.admin.sub, reviewerDisplayName: "admin", decidedAt: api.deps.now(),
      });
    };
    const res = await decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ALREADY_DECIDED");
    expect(decisionItems()).toHaveLength(1);
    expect(decisionItems()[0]).toMatchObject({ reviewerSub: PEOPLE.admin.sub, decision: "REQUEST_REVISION" });
  });
});

describe("beginning the next attempt holds under races", () => {
  it("an assignment that no longer points at the previous session at commit time cancels it", async () => {
    await decide(api, PEOPLE.mgrA, submissionId, { decision: "REQUEST_REVISION", feedback: FEEDBACK });
    let fired = false;
    api.db.beforeTransact = () => {
      if (fired) return;
      fired = true;
      api.db.put(CORE, { ...assignmentItem(), sessionId: "ses_" + "e".repeat(32) });
    };
    const before = api.db.all(CORE).filter((i) => i["entityType"] === "SESSION_STATE").length;
    const res = await startAs(api, PEOPLE.empA, assignmentId);
    expect(res.status).toBe(409);
    expect(api.db.all(CORE).filter((i) => i["entityType"] === "SESSION_STATE")).toHaveLength(before);
  });
});

describe("manager decisions", () => {
  it("APPROVE: immutable decision under the verified reviewer identity, session event, assignment APPROVED", async () => {
    const v = sessionItem()["stateVersion"] as number;
    const res = await decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" });
    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({
      canDecide: false,
      assignment: { status: "APPROVED" },
      submission: { review: { decision: "APPROVE", feedback: null, reviewerDisplayName: "manager" } },
    });
    expect(decisionItems()).toHaveLength(1);
    expect(decisionItems()[0]).toMatchObject({
      PK: `ASSIGN#${assignmentId}`, SK: "DECISION#01", submissionId, decision: "APPROVE",
      reviewerSub: PEOPLE.mgrA.sub, decidedAt: api.deps.now(),
    });
    expect(sessionItem()).toMatchObject({ reviewDecision: "APPROVE", stateVersion: v + 1, phase: "SUBMITTED" });
    expect(eventsOf().at(-1)).toMatchObject({ type: "REVIEW_DECIDED", stateVersion: v + 1, actorSub: PEOPLE.mgrA.sub });
    expect(assignmentItem()["status"]).toBe("APPROVED");
  });

  it("the reviewer identity comes from the token, never the body", async () => {
    const res = await api.call({ route: R.decide, as: PEOPLE.mgrA, params: { submissionId }, body: { decision: "APPROVE", reviewerSub: "attacker-sub" } });
    expect(res.status).toBe(400);
    expect(decisionItems()).toHaveLength(0);
    await decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" });
    expect(decisionItems()[0]!["reviewerSub"]).toBe(PEOPLE.mgrA.sub);
  });

  it("an org admin may decide; the decision records the admin, not the original assigner", async () => {
    expect((await decide(api, PEOPLE.admin, submissionId, { decision: "APPROVE" })).status).toBe(200);
    expect(decisionItems()[0]).toMatchObject({ reviewerSub: PEOPLE.admin.sub, reviewerDisplayName: "admin" });
  });

  it("REQUEST_REVISION stores the feedback and moves the assignment to REVISION_REQUESTED", async () => {
    const res = await decide(api, PEOPLE.mgrA, submissionId, { decision: "REQUEST_REVISION", feedback: `  ${FEEDBACK}  ` });
    expect(res.status).toBe(200);
    expect(res.body.review.submission.review).toMatchObject({ decision: "REQUEST_REVISION", feedback: FEEDBACK });
    expect(assignmentItem()["status"]).toBe("REVISION_REQUESTED");
    expect(sessionItem()["reviewDecision"]).toBe("REQUEST_REVISION");
  });

  it("an optional approval note is kept", async () => {
    await decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE", feedback: "Nice, well documented work." });
    expect(decisionItems()[0]!["feedback"]).toBe("Nice, well documented work.");
  });

  it.each([
    ["no feedback", { decision: "REQUEST_REVISION" }],
    ["empty feedback", { decision: "REQUEST_REVISION", feedback: "" }],
    ["whitespace feedback", { decision: "REQUEST_REVISION", feedback: "          " }],
    ["too-short feedback", { decision: "REQUEST_REVISION", feedback: "fix it" }],
    ["over-long feedback", { decision: "REQUEST_REVISION", feedback: "f".repeat(1501) }],
    ["an unknown decision", { decision: "REJECT" }],
    ["a lower-case decision", { decision: "approve" }],
    ["no decision", {}],
    ["a forged status", { decision: "APPROVE", status: "APPROVED" }],
    ["a forged submission id", { decision: "APPROVE", submissionId: "sub_01_" + "f".repeat(32) }],
    ["a non-string feedback", { decision: "APPROVE", feedback: 7 }],
  ])("rejects %s with 400 and writes nothing", async (_n, body) => {
    const before = snapshot();
    const res = await decide(api, PEOPLE.mgrA, submissionId, body);
    expect(res.status).toBe(400);
    expect(snapshot()).toBe(before);
  });

  it("rejects a missing body", async () => {
    expect((await api.call({ route: R.decide, as: PEOPLE.mgrA, params: { submissionId } })).status).toBe(400);
  });

  it("the employee cannot approve their own work or request a revision, whatever they send", async () => {
    const before = snapshot();
    for (const body of [{ decision: "APPROVE" }, { decision: "REQUEST_REVISION", feedback: FEEDBACK }, { decision: "APPROVE", role: "manager" }]) {
      const res = await decide(api, PEOPLE.empA, submissionId, body);
      expect([400, 404]).toContain(res.status);
    }
    expect(snapshot()).toBe(before);
    expect(assignmentItem()["status"]).toBe("AWAITING_REVIEW");
  });
});

describe("decisions are immutable and cannot race", () => {
  it("a second, different decision is refused and the first is untouched", async () => {
    await decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" });
    const stored = structuredClone(decisionItems()[0]);
    const after = snapshot();

    const flip = await decide(api, PEOPLE.mgrA, submissionId, { decision: "REQUEST_REVISION", feedback: FEEDBACK });
    expect(flip.status).toBe(409);
    expect(flip.body.code).toBe("ALREADY_DECIDED");
    expect(decisionItems()[0]).toEqual(stored);
    expect(snapshot()).toBe(after);
    expect(assignmentItem()["status"]).toBe("APPROVED");
  });

  it("a different reviewer cannot overwrite it either, even with the identical decision", async () => {
    await decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" });
    const after = snapshot();
    const res = await decide(api, PEOPLE.admin, submissionId, { decision: "APPROVE" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ALREADY_DECIDED");
    expect(snapshot()).toBe(after);
  });

  it("repeating the identical decision by the same reviewer is an idempotent retry: no new item, no new event", async () => {
    await decide(api, PEOPLE.mgrA, submissionId, { decision: "REQUEST_REVISION", feedback: FEEDBACK });
    const after = snapshot();
    const retry = await decide(api, PEOPLE.mgrA, submissionId, { decision: "REQUEST_REVISION", feedback: FEEDBACK });
    expect(retry.status).toBe(200);
    expect(snapshot()).toBe(after);
    expect(decisionItems()).toHaveLength(1);
    expect(eventsOf().filter((e) => e["type"] === "REVIEW_DECIDED")).toHaveLength(1);
  });

  it("two managers racing with opposite decisions: exactly one wins and everything agrees with the winner", async () => {
    const [a, b] = await Promise.all([
      decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" }),
      decide(api, PEOPLE.admin, submissionId, { decision: "REQUEST_REVISION", feedback: FEEDBACK }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(decisionItems()).toHaveLength(1);
    expect(eventsOf().filter((e) => e["type"] === "REVIEW_DECIDED")).toHaveLength(1);
    const winner = decisionItems()[0]!["decision"];
    expect(assignmentItem()["status"]).toBe(winner === "APPROVE" ? "APPROVED" : "REVISION_REQUESTED");
    expect(sessionItem()["reviewDecision"]).toBe(winner);
  });

  it("a concurrent identical decision by the same manager results in a single decision and event", async () => {
    const [a, b] = await Promise.all([
      decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" }),
      decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(decisionItems()).toHaveLength(1);
    expect(eventsOf().filter((e) => e["type"] === "REVIEW_DECIDED")).toHaveLength(1);
  });

  it("a competing session write between read and write cancels the whole decision", async () => {
    let fired = false;
    api.db.beforeTransact = () => {
      if (fired) return;
      fired = true;
      api.db.put(CORE, { ...sessionItem(), stateVersion: (sessionItem()["stateVersion"] as number) + 1 });
    };
    const res = await decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" });
    expect(res.status).toBe(409);
    expect(decisionItems()).toHaveLength(0);
    expect(assignmentItem()["status"]).toBe("AWAITING_REVIEW");
  });

  it("a storage failure commits nothing and the decision can be retried", async () => {
    const before = snapshot();
    api.db.fail = (cmd) => (cmd === "TransactWrite" ? new Error("simulated outage") : null);
    const failed = await decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" });
    api.db.fail = null;
    expect(failed.status).toBe(500);
    expect(snapshot()).toBe(before);
    expect((await decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" })).status).toBe(200);
  });

  it("cannot decide evidence that is not the submission currently under review", async () => {
    api.db.put(CORE, { ...assignmentItem(), latestSubmissionId: "sub_02_" + assignmentId.slice(4) });
    const res = await decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOT_AWAITING_REVIEW");
    expect(decisionItems()).toHaveLength(0);
  });

  it("cannot decide when the assignment is not awaiting review", async () => {
    api.db.put(CORE, { ...assignmentItem(), status: "IN_PROGRESS" });
    const res = await decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" });
    expect(res.status).toBe(409);
    expect(decisionItems()).toHaveLength(0);
  });

  it("the frozen submission is unchanged by the decision", async () => {
    const frozen = structuredClone(submissionItems()[0]);
    await decide(api, PEOPLE.mgrA, submissionId, { decision: "REQUEST_REVISION", feedback: FEEDBACK });
    expect(submissionItems()[0]).toEqual(frozen);
  });

  it("an inconsistent submitted session fails closed (500) instead of recording a decision", async () => {
    api.db.put(CORE, { ...sessionItem(), submissionId: "sub_01_" + "9".repeat(32) });
    const res = await decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" });
    expect(res.status).toBe(500);
    expect(decisionItems()).toHaveLength(0);
  });
});

describe("what the employee sees and the manager's queue", () => {
  it("the employee reads the outcome and the feedback, but not the reviewer's identity", async () => {
    await decide(api, PEOPLE.mgrA, submissionId, { decision: "REQUEST_REVISION", feedback: FEEDBACK });
    const res = await api.call({ route: R.session, as: PEOPLE.empA, params: { sessionId } });
    expect(res.body.session.submission.review).toMatchObject({ decision: "REQUEST_REVISION", feedback: FEEDBACK, reviewerDisplayName: "manager" });
    expect(res.body.session.submissions[0].review.decision).toBe("REQUEST_REVISION");
    expect(res.raw).not.toContain(PEOPLE.mgrA.sub);
  });

  it("the review queue is the manager's existing assignment list: status and link update, GSI2 prefix is unchanged", async () => {
    const list = () => api.call({ route: R.list, as: PEOPLE.mgrA, params: { orgId: ORG } });
    const waiting = (await list()).body.assignments[0];
    expect(waiting).toMatchObject({ status: "AWAITING_REVIEW", latestSubmissionId: submissionId, attemptNumber: 1 });
    expect(String(assignmentItem()["GSI2SK"])).toMatch(/^ASSIGN#/);

    await decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" });
    expect((await list()).body.assignments[0]).toMatchObject({ status: "APPROVED", latestSubmissionId: submissionId });
    expect(String(assignmentItem()["GSI2SK"])).toMatch(/^ASSIGN#/);

    // the employee sees their own status too, without the manager block
    const mine = await api.call({ route: R.list, as: PEOPLE.empA, params: { orgId: ORG } });
    expect(mine.body.assignments[0]).toMatchObject({ status: "APPROVED" });
    expect(mine.body.assignments[0]).not.toHaveProperty("employee");
  });

  it("starting after a submission just reopens the (read-only) submitted session", async () => {
    const res = await startAs(api, PEOPLE.empA, assignmentId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: false, session: { sessionId, phase: "SUBMITTED" } });
  });
});

// ---------------------------------------------------------------------------

describe("revision workflow: the next attempt never overwrites the previous one", () => {
  beforeEach(async () => {
    await decide(api, PEOPLE.mgrA, submissionId, { decision: "REQUEST_REVISION", feedback: FEEDBACK });
  });

  it("the employee begins attempt 2 as a NEW session; attempt 1's session, submission, decision and events are untouched", async () => {
    const old = { session: sessionItem(), sub: structuredClone(submissionItems()[0]), dec: structuredClone(decisionItems()[0]), events: structuredClone(eventsOf()) };

    const res = await startAs(api, PEOPLE.empA, assignmentId);
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    const s2 = res.body.session;
    expect(s2.sessionId).not.toBe(sessionId);
    expect(s2).toMatchObject({
      attemptNumber: 2, phase: "INVESTIGATING", stateVersion: 1, scenarioId: "inc-104", scenarioVersion: 1,
      configRevision: 0, revisions: [], testRuns: [], submission: null, activeTestRunId: null,
    });
    // the previous attempt and its manager feedback stay visible
    expect(s2.submissions).toHaveLength(1);
    expect(s2.submissions[0]).toMatchObject({ attemptNumber: 1, review: { decision: "REQUEST_REVISION", feedback: FEEDBACK } });

    expect(assignmentItem()).toMatchObject({ status: "IN_PROGRESS", sessionId: s2.sessionId, attemptNumber: 2 });
    expect(sessionItem()).toEqual(old.session);
    expect(submissionItems()[0]).toEqual(old.sub);
    expect(decisionItems()[0]).toEqual(old.dec);
    expect(eventsOf()).toEqual(old.events);
    expect(eventsOf(s2.sessionId)).toHaveLength(1);
  });

  it("beginning twice (double click / retry) yields one new attempt", async () => {
    const [a, b] = await Promise.all([startAs(api, PEOPLE.empA, assignmentId), startAs(api, PEOPLE.empA, assignmentId)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.session.sessionId).toBe(b.body.session.sessionId);
    const sessions = api.db.all(CORE).filter((i) => i["entityType"] === "SESSION_STATE");
    expect(sessions).toHaveLength(2);
    const again = await startAs(api, PEOPLE.empA, assignmentId);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
  });

  it("only the assigned employee can begin it", async () => {
    const before = snapshot();
    for (const who of [PEOPLE.empA2, PEOPLE.mgrA, PEOPLE.admin, PEOPLE.otherEmp, "ghost-sub"]) {
      expect((await startAs(api, who, assignmentId)).status).toBe(404);
    }
    expect(snapshot()).toBe(before);
  });

  it("the locked old attempt stays locked even after attempt 2 exists", async () => {
    await startAs(api, PEOPLE.empA, assignmentId);
    const v = sessionItem()["stateVersion"] as number;
    const res = await api.call({ route: R.saveConfig, as: PEOPLE.empA, params: { sessionId }, body: { expectedStateVersion: v, config: { request_timeout_ms: 1900 } } });
    expect(res.status).toBe(422);
    expect((await submitReport(api, PEOPLE.empA, sessionId)).status).toBeGreaterThanOrEqual(409);
  });

  it("attempt 2: update config, rerun, submit, get approved; history keeps both attempts", async () => {
    const s2 = (await startAs(api, PEOPLE.empA, assignmentId)).body.session;
    const sub2 = await finishAttempt(api, PEOPLE.empA, s2.sessionId, 1800);
    expect(sub2).toMatch(/^sub_02_/);
    expect(assignmentItem()).toMatchObject({ status: "AWAITING_REVIEW", latestSubmissionId: sub2, attemptNumber: 2 });

    const bundle = (await getReview(api, PEOPLE.mgrA, sub2)).body.review;
    expect(bundle.canDecide).toBe(true);
    expect(bundle.submission).toMatchObject({ attemptNumber: 2, config: { snapshot: { request_timeout_ms: 1800 } }, testRun: { status: "PASSED" } });
    expect(bundle.history.map((h: any) => [h.attemptNumber, h.review?.decision ?? null])).toEqual([[2, null], [1, "REQUEST_REVISION"]]);
    expect(bundle.timeline[0]).toMatchObject({ sequence: 1, type: "INVESTIGATION_STARTED" }); // attempt 2's own stream

    expect((await decide(api, PEOPLE.mgrA, sub2, { decision: "APPROVE" })).status).toBe(200);
    expect(assignmentItem()["status"]).toBe("APPROVED");

    const final = await sessionView(PEOPLE.empA, s2.sessionId);
    expect(final.submission.review.decision).toBe("APPROVE");
    expect(final.submissions.map((x: any) => [x.attemptNumber, x.review.decision])).toEqual([[2, "APPROVE"], [1, "REQUEST_REVISION"]]);
  });

  it("the earlier attempt's review remains readable but is no longer decidable", async () => {
    const s2 = (await startAs(api, PEOPLE.empA, assignmentId)).body.session;
    await finishAttempt(api, PEOPLE.empA, s2.sessionId, 1800);
    const old = (await getReview(api, PEOPLE.mgrA, submissionId)).body.review;
    expect(old.canDecide).toBe(false);
    expect(old.submission.review.decision).toBe("REQUEST_REVISION");
    expect((await decide(api, PEOPLE.mgrA, submissionId, { decision: "APPROVE" })).status).toBe(409);
  });

  it("after approval nothing further can be started, submitted or decided", async () => {
    const s2 = (await startAs(api, PEOPLE.empA, assignmentId)).body.session;
    const sub2 = await finishAttempt(api, PEOPLE.empA, s2.sessionId, 1800);
    await decide(api, PEOPLE.mgrA, sub2, { decision: "APPROVE" });
    const after = snapshot();
    const reopen = await startAs(api, PEOPLE.empA, assignmentId);
    expect(reopen.status).toBe(200);
    expect(reopen.body.session.phase).toBe("SUBMITTED");
    expect((await decide(api, PEOPLE.mgrA, sub2, { decision: "REQUEST_REVISION", feedback: FEEDBACK })).status).toBe(409);
    expect(snapshot()).toBe(after);
  });

  it("stops at the attempt limit: the last attempt cannot be sent back, and a sixth cannot begin", async () => {
    let id = submissionId; // attempt 1 already has REQUEST_REVISION
    for (let attempt = 2; attempt <= 5; attempt++) {
      const s = (await startAs(api, PEOPLE.empA, assignmentId)).body.session;
      expect(s.attemptNumber).toBe(attempt);
      id = await finishAttempt(api, PEOPLE.empA, s.sessionId, 1800 - attempt);
      if (attempt < 5) expect((await decide(api, PEOPLE.mgrA, id, { decision: "REQUEST_REVISION", feedback: FEEDBACK })).status).toBe(200);
    }
    const last = await decide(api, PEOPLE.mgrA, id, { decision: "REQUEST_REVISION", feedback: FEEDBACK });
    expect(last.status).toBe(422);
    expect(last.body.code).toBe("ATTEMPT_LIMIT_REACHED");
    expect((await decide(api, PEOPLE.mgrA, id, { decision: "APPROVE" })).status).toBe(200);

    // and even if state were forced to REVISION_REQUESTED, attempt 6 is refused
    api.db.put(CORE, { ...assignmentItem(), status: "REVISION_REQUESTED" });
    const six = await startAs(api, PEOPLE.empA, assignmentId);
    expect(six.status).toBe(409);
    expect(six.body.code).toBe("ATTEMPT_LIMIT_REACHED");
  });

  it("a storage failure while beginning commits nothing", async () => {
    const before = snapshot();
    api.db.fail = (cmd) => (cmd === "TransactWrite" ? new Error("simulated outage") : null);
    expect((await startAs(api, PEOPLE.empA, assignmentId)).status).toBe(500);
    api.db.fail = null;
    expect(snapshot()).toBe(before);
    expect(assignmentItem()["status"]).toBe("REVISION_REQUESTED");
    expect((await startAs(api, PEOPLE.empA, assignmentId)).status).toBe(201);
  });
});

describe("Phase 2A/2B/2C behaviour on the same data is unchanged", () => {
  it("a different employee's untouched assignment still starts, edits and runs normally", async () => {
    const f = createApi();
    const r = await readyToSubmit(f, 1800, PEOPLE.empA2);
    expect(r.run.body.testRun.status).toBe("PASSED");
    expect(f.db.all(CORE).filter((i) => i["entityType"] === "SUBMISSION")).toHaveLength(0);
  });
});
