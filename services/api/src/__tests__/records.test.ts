/**
 * Direct tests for the validation and projection layers. The route tests exercise
 * these indirectly, but several defenses overlap (e.g. the response contract
 * strips unknown keys AND the view builder never adds them). Testing each layer
 * on its own means removing one later cannot hide behind the other.
 */
import { describe, expect, it } from "vitest";
import { INC_104_V1 } from "@onboardos/scenario-fixtures";
import { createSession, startSession } from "@onboardos/scenario-engine";
import { canAssign } from "../authz.js";
import { assignmentIdFor, sessionIdFor } from "../ids.js";
import {
  buildAssignmentRecord,
  eventItem,
  keys,
  parseAssignment,
  parseMember,
  parseSessionState,
  sessionItem,
  toAssignmentView,
  toSessionView,
  type Member,
} from "../records.js";

const ORG = "northstar-cloud";
const EMP = "emp-a-sub";
const MGR = "mgr-a-sub";
const NOW = "2026-11-07T10:00:00.000Z";

const record = () =>
  buildAssignmentRecord({
    assignmentId: assignmentIdFor(ORG, "inc-104", 1, EMP),
    organizationId: ORG,
    scenario: INC_104_V1,
    employeeSub: EMP,
    employeeDisplayName: "employee",
    assignedBySub: MGR,
    now: NOW,
  });

describe("deterministic ids", () => {
  it("derive the same id from the same facts, and a different id when any fact differs", () => {
    const base = assignmentIdFor(ORG, "inc-104", 1, EMP);
    expect(assignmentIdFor(ORG, "inc-104", 1, EMP)).toBe(base);
    expect(assignmentIdFor("other-corp", "inc-104", 1, EMP)).not.toBe(base);
    expect(assignmentIdFor(ORG, "inc-105", 1, EMP)).not.toBe(base);
    expect(assignmentIdFor(ORG, "inc-104", 2, EMP)).not.toBe(base);
    expect(assignmentIdFor(ORG, "inc-104", 1, "emp-other")).not.toBe(base);
    expect(base).toMatch(/^asg_[0-9a-f]{32}$/);
  });

  it("session ids follow the assignment and the attempt", () => {
    const a = assignmentIdFor(ORG, "inc-104", 1, EMP);
    expect(sessionIdFor(a)).toBe(sessionIdFor(a, 1));
    expect(sessionIdFor(a, 2)).not.toBe(sessionIdFor(a, 1));
    expect(sessionIdFor(a)).toMatch(/^ses_[0-9a-f]{32}$/);
  });
});

describe("parseAssignment: validates content and cross-checks keys", () => {
  it("accepts a record built by buildAssignmentRecord (round trip)", () => {
    expect(parseAssignment(record())).not.toBeNull();
  });

  it.each([
    ["GSI1PK for a different employee", { GSI1PK: keys.employeeIndex(ORG, "someone-else") }],
    ["GSI1PK for a different organization", { GSI1PK: keys.employeeIndex("other-corp", EMP) }],
    ["GSI2PK for a different manager", { GSI2PK: keys.managerIndex(ORG, "someone-else") }],
    ["a primary key that does not match the id", { PK: "ASSIGN#asg_" + "0".repeat(32) }],
    ["an unknown status", { status: "DONE" }],
    ["a malformed id", { assignmentId: "../../x", PK: "ASSIGN#../../x" }],
    ["a key-injection employee sub", { employeeSub: "x#MANAGER#y" }],
    ["a missing field", { scenarioTitle: undefined }],
    ["a non-numeric version", { scenarioVersion: "1" }],
    ["a malformed session id", { sessionId: "not-a-session" }],
  ])("rejects a record with %s", (_label, patch) => {
    expect(parseAssignment({ ...record(), ...patch })).toBeNull();
  });

  it("rejects non-objects", () => {
    for (const v of [null, undefined, "x", 3, []]) expect(parseAssignment(v)).toBeNull();
  });
});

describe("toAssignmentView: the client projection", () => {
  it("employee view: exactly the contract fields, no employee block, no manager identity", () => {
    const v = toAssignmentView(record(), false);
    expect(Object.keys(v).sort()).toEqual(
      ["assignmentId", "attemptNumber", "createdAt", "latestSubmissionId", "organizationId", "scenarioId", "scenarioTitle", "scenarioVersion", "sessionId", "startedAt", "status"],
    );
    expect(JSON.stringify(v)).not.toContain(MGR);
  });

  it("manager view: adds the employee reference only", () => {
    const v = toAssignmentView(record(), true);
    expect(v.employee).toEqual({ userSub: EMP, displayName: "employee" });
    expect(Object.keys(v)).toContain("employee");
    expect(JSON.stringify(v)).not.toMatch(/assignedBySub|GSI|entityType|"PK"/);
  });
});

describe("parseMember", () => {
  const item = {
    PK: `ORG#${ORG}`, SK: `MEMBER#${EMP}`, role: "employee", status: "ACTIVE",
    teamIds: ["team-a"], preferredUsername: "employee", email: "e@secret.example",
  };

  it("reads org and sub from the KEY and a safe display name (never the email)", () => {
    expect(parseMember(item)).toEqual({
      organizationId: ORG, userSub: EMP, role: "employee", status: "ACTIVE", teamIds: ["team-a"], displayName: "employee",
    });
  });

  it("falls back to a generic display name rather than exposing the email", () => {
    const m = parseMember({ ...item, preferredUsername: undefined });
    expect(m?.displayName).toBe("Employee");
    expect(JSON.stringify(m)).not.toContain("secret.example");
  });

  it.each([
    ["an unknown role", { role: "superadmin" }],
    ["an unknown status", { status: "MAYBE" }],
    ["a non-array team list", { teamIds: "team-a" }],
    ["a missing team list", { teamIds: undefined }],
    ["a key that is not a membership key", { SK: "PROFILE" }],
    ["a key-injection sub", { SK: "MEMBER#a#b" }],
    ["a key that is not an org key", { PK: "ASSIGN#x" }],
  ])("rejects %s", (_label, patch) => {
    expect(parseMember({ ...item, ...patch })).toBeNull();
  });
});

describe("canAssign: org + role + team scope", () => {
  const m = (over: Partial<Member>): Member => ({
    organizationId: ORG, userSub: "u", role: "employee", status: "ACTIVE", teamIds: ["team-a"], displayName: "x", ...over,
  });

  it("a manager may assign an ACTIVE employee who shares a team", () => {
    expect(canAssign(m({ role: "manager" }), m({}))).toBe(true);
  });
  it("a manager may not assign across teams", () => {
    expect(canAssign(m({ role: "manager", teamIds: ["team-b"] }), m({}))).toBe(false);
  });
  it("a manager with no teams can assign nobody", () => {
    expect(canAssign(m({ role: "manager", teamIds: [] }), m({}))).toBe(false);
  });
  it("an org admin may assign any ACTIVE employee in the same organization", () => {
    expect(canAssign(m({ role: "org_admin", teamIds: [] }), m({ teamIds: ["team-z"] }))).toBe(true);
  });
  it("nobody may assign across organizations, even an admin", () => {
    expect(canAssign(m({ role: "org_admin" }), m({ organizationId: "other-corp" }))).toBe(false);
    expect(canAssign(m({ role: "manager" }), m({ organizationId: "other-corp" }))).toBe(false);
  });
  it("the target must be an ACTIVE employee", () => {
    const admin = m({ role: "org_admin" });
    expect(canAssign(admin, m({ role: "manager" }))).toBe(false);
    expect(canAssign(admin, m({ role: "org_admin" }))).toBe(false);
    expect(canAssign(admin, m({ status: "SUSPENDED" }))).toBe(false);
    expect(canAssign(admin, m({ status: "INVITED" }))).toBe(false);
  });
  it("an employee can assign nobody", () => {
    expect(canAssign(m({}), m({}))).toBe(false);
  });
});

describe("session records", () => {
  const init = { sessionId: sessionIdFor("asg_" + "a".repeat(32)), assignmentId: "asg_" + "a".repeat(32), organizationId: ORG, employeeSub: EMP };
  const started = () => {
    const r = startSession(INC_104_V1, init, { now: NOW, actorSub: EMP });
    if (!r.ok) throw new Error("start failed");
    return r;
  };

  it("round-trips engine state through its stored item", () => {
    const { nextState } = started();
    expect(parseSessionState(sessionItem(nextState))).toEqual(nextState);
  });

  it.each([
    ["an unknown phase", { phase: "WARP_SPEED" }],
    ["a negative version", { stateVersion: -1 }],
    ["a config with an extra key", { config: { request_timeout_ms: 800, extra: 1 } }],
    ["a string config value", { config: { request_timeout_ms: "800" } }],
    ["a session key that does not match its id", { PK: "SESSION#ses_" + "f".repeat(32) }],
    ["a missing owner", { employeeSub: undefined }],
  ])("rejects a stored session with %s", (_label, patch) => {
    expect(parseSessionState({ ...sessionItem(started().nextState), ...patch })).toBeNull();
  });

  it("drops storage-only attributes when parsing to engine state", () => {
    const parsed = parseSessionState({ ...sessionItem(started().nextState), PK2: "x", junk: 1 });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!)).not.toContain("junk");
    expect(Object.keys(parsed!)).not.toContain("PK");
  });

  it("builds event items keyed by zero-padded sequence, carrying the version", () => {
    const { nextState, events } = started();
    const item = eventItem(nextState, events[0]!);
    expect(item).toMatchObject({
      PK: `SESSION#${init.sessionId}`, SK: "SEQ#0000000001", type: "INVESTIGATION_STARTED",
      stateVersion: 1, organizationId: ORG, actorSub: EMP,
    });
    expect(keys.event("s", 12).SK).toBe("SEQ#0000000012");
    expect(keys.event("s", 9).SK < keys.event("s", 10).SK).toBe(true); // sorts correctly
  });

  it("toSessionView exposes only contract fields and strips suite/rubric identifiers", () => {
    const view = toSessionView(started().nextState, INC_104_V1);
    expect(JSON.stringify(view)).not.toMatch(/testSuite|rubric|inc-104-checkout-timeout|employeeSub/i);
    expect(view.scenario).toEqual(INC_104_V1.content);
    expect(view.config).toEqual({ request_timeout_ms: 800 });
  });

  it("toSessionView strips attributes smuggled into state", () => {
    const polluted = { ...started().nextState, hiddenAnswer: 1800, PK: "SESSION#x" } as never;
    const json = JSON.stringify(toSessionView(polluted, INC_104_V1));
    expect(json).not.toContain("hiddenAnswer");
    expect(json).not.toContain("SESSION#x");
  });

  it("createSession output is not accepted as a started session record without a phase change", () => {
    const pre = createSession(INC_104_V1, init, NOW);
    expect(parseSessionState(sessionItem(pre))).toEqual(pre);
    expect(pre.phase).toBe("NOT_STARTED");
  });
});
