import { beforeEach, describe, expect, it } from "vitest";
import {
  CORE,
  ORG,
  OTHER_ORG,
  PEOPLE,
  R,
  assign,
  createApi,
  seedMember,
  type Api,
} from "./harness.js";

let api: Api;
beforeEach(() => {
  api = createApi();
});

const employeesAs = (who: Parameters<Api["call"]>[0]["as"], org = ORG) =>
  api.call({ route: R.employees, as: who, params: { orgId: org } });
const listAs = (who: Parameters<Api["call"]>[0]["as"], org = ORG) =>
  api.call({ route: R.list, as: who, params: { orgId: org } });

describe("GET assignable-employees: scope and redaction", () => {
  it("a manager sees only ACTIVE employees on their own team", async () => {
    const r = await employeesAs(PEOPLE.mgrA);
    expect(r.status).toBe(200);
    expect(r.body.employees.map((e: any) => e.userSub).sort()).toEqual([PEOPLE.empA.sub, PEOPLE.empA2.sub].sort());
  });

  it("excludes other teams, suspended employees, non-employees and other organizations", async () => {
    const subs = (await employeesAs(PEOPLE.mgrA)).body.employees.map((e: any) => e.userSub);
    for (const hidden of [PEOPLE.empB, PEOPLE.empSuspended, PEOPLE.mgrA, PEOPLE.mgrB, PEOPLE.admin, PEOPLE.otherEmp]) {
      expect(subs).not.toContain(hidden.sub);
    }
  });

  it("a manager of another team sees only their team", async () => {
    const r = await employeesAs(PEOPLE.mgrB);
    expect(r.body.employees.map((e: any) => e.userSub)).toEqual([PEOPLE.empB.sub]);
  });

  it("an org admin sees every ACTIVE employee in the organization", async () => {
    const subs = (await employeesAs(PEOPLE.admin)).body.employees.map((e: any) => e.userSub).sort();
    expect(subs).toEqual([PEOPLE.empA.sub, PEOPLE.empA2.sub, PEOPLE.empB.sub].sort());
  });

  it("returns only userSub, displayName and teamIds: never email or internal attributes", async () => {
    const r = await employeesAs(PEOPLE.mgrA);
    for (const e of r.body.employees) expect(Object.keys(e).sort()).toEqual(["displayName", "teamIds", "userSub"]);
    expect(r.raw).not.toContain("secret.example");
  });

  it("denies an employee (403) and an unrelated-org member (404)", async () => {
    expect((await employeesAs(PEOPLE.empA)).status).toBe(403);
    expect((await employeesAs(PEOPLE.otherMgr)).status).toBe(404);
  });

  it("a manager with no teams can assign nobody", async () => {
    seedMember(api.db, { sub: "lonely-mgr", role: "manager", teams: [], name: "lonely" });
    expect((await employeesAs("lonely-mgr")).body.employees).toEqual([]);
  });

  it("uses a single-partition Query, never a Scan", async () => {
    await employeesAs(PEOPLE.mgrA);
    const q = api.db.sent.filter((c) => c.command === "Query");
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ table: CORE });
    expect(api.db.sent.some((c) => c.command === "Scan")).toBe(false);
  });
});

describe("POST assignments: authorization", () => {
  it("lets a manager assign INC-104 to an employee on their team", async () => {
    const r = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(true);
    expect(r.body.assignment).toMatchObject({
      organizationId: ORG,
      scenarioId: "inc-104",
      scenarioVersion: 1,
      scenarioTitle: "INC-104: Checkout API timeouts",
      status: "ASSIGNED",
      sessionId: null,
      startedAt: null,
      employee: { userSub: PEOPLE.empA.sub, displayName: "employee" },
    });
    expect(r.body.assignment.assignmentId).toMatch(/^asg_[0-9a-f]{32}$/);
  });

  it("lets an org admin assign across teams", async () => {
    expect((await assign(api, PEOPLE.admin, PEOPLE.empB)).status).toBe(201);
  });

  it("denies an employee (403) and writes nothing", async () => {
    const r = await assign(api, PEOPLE.empA, PEOPLE.empA2);
    expect(r.status).toBe(403);
    expect(api.db.all(CORE).some((i) => String(i["PK"]).startsWith("ASSIGN#"))).toBe(false);
  });

  it("denies a manager assigning outside their team with the SAME opaque 404 as a nonexistent user", async () => {
    const outside = await assign(api, PEOPLE.mgrA, PEOPLE.empB);
    const ghost = await api.call({
      route: R.create, as: PEOPLE.mgrA, params: { orgId: ORG },
      body: { scenarioId: "inc-104", employeeSub: "ghost-sub" },
    });
    expect(outside.status).toBe(404);
    expect(ghost.status).toBe(404);
    expect({ code: outside.body.code, message: outside.body.message }).toEqual({ code: ghost.body.code, message: ghost.body.message });
    expect(api.db.all(CORE).some((i) => String(i["PK"]).startsWith("ASSIGN#"))).toBe(false);
  });

  it.each([
    ["a suspended employee", PEOPLE.empSuspended],
    ["a manager", PEOPLE.mgrB],
    ["an org admin", PEOPLE.admin],
    ["an employee of another organization", PEOPLE.otherEmp],
  ])("refuses to assign to %s (opaque 404)", async (_label, target) => {
    const r = await assign(api, PEOPLE.mgrA, target);
    expect(r.status).toBe(404);
  });

  it("denies a member of a different organization using this org's URL", async () => {
    const r = await api.call({
      route: R.create, as: PEOPLE.otherMgr, params: { orgId: ORG },
      body: { scenarioId: "inc-104", employeeSub: PEOPLE.empA.sub },
    });
    expect(r.status).toBe(404);
  });

  it("denies an INVITED/SUSPENDED manager (inactive membership)", async () => {
    seedMember(api.db, { sub: "susp-mgr", role: "manager", teams: ["team-a"], name: "susp", status: "SUSPENDED" });
    const r = await api.call({
      route: R.create, as: "susp-mgr", params: { orgId: ORG },
      body: { scenarioId: "inc-104", employeeSub: PEOPLE.empA.sub },
    });
    expect(r.status).toBe(404);
  });

  it("fails closed on a malformed caller membership (unknown role value)", async () => {
    api.db.put(CORE, { PK: `ORG#${ORG}`, SK: "MEMBER#bad-mgr", role: "superadmin", status: "ACTIVE", teamIds: ["team-a"] });
    const r = await api.call({
      route: R.create, as: "bad-mgr", params: { orgId: ORG },
      body: { scenarioId: "inc-104", employeeSub: PEOPLE.empA.sub },
    });
    expect(r.status).toBe(404);
  });

  it("fails closed on a membership with no team list", async () => {
    api.db.put(CORE, { PK: `ORG#${ORG}`, SK: "MEMBER#no-teams", role: "manager", status: "ACTIVE" });
    expect((await employeesAs("no-teams")).status).toBe(404);
  });

  it("derives the assigning manager from the token, not the request", async () => {
    const r = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    const stored = api.db.get(CORE, { PK: `ASSIGN#${r.body.assignment.assignmentId}`, SK: "META" });
    expect(stored).toMatchObject({
      assignedBySub: PEOPLE.mgrA.sub,
      organizationId: ORG,
      employeeSub: PEOPLE.empA.sub,
      status: "ASSIGNED",
      GSI1PK: `ORG#${ORG}#EMP#${PEOPLE.empA.sub}`,
      GSI2PK: `ORG#${ORG}#MANAGER#${PEOPLE.mgrA.sub}`,
    });
  });
});

describe("POST assignments: input validation (strict contract)", () => {
  const post = (body: unknown) => api.call({ route: R.create, as: PEOPLE.mgrA, params: { orgId: ORG }, body });
  const noAssignments = () => expect(api.db.all(CORE).some((i) => String(i["PK"]).startsWith("ASSIGN#"))).toBe(false);

  it.each([
    ["role", { role: "org_admin" }],
    ["organizationId", { organizationId: OTHER_ORG }],
    ["managerSub", { managerSub: "someone" }],
    ["assignedBySub", { assignedBySub: "someone" }],
    ["status", { status: "IN_PROGRESS" }],
    ["scenarioVersion", { scenarioVersion: 99 }],
    ["passed", { passed: true }],
  ])("rejects a forged '%s' field with 400 and creates nothing", async (_name, extra) => {
    const r = await post({ scenarioId: "inc-104", employeeSub: PEOPLE.empA.sub, ...extra });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("INVALID_REQUEST");
    noAssignments();
  });

  it.each([
    ["missing employeeSub", { scenarioId: "inc-104" }],
    ["missing scenarioId", { employeeSub: PEOPLE.empA.sub }],
    ["a key-injection employeeSub", { scenarioId: "inc-104", employeeSub: "x#MANAGER#y" }],
    ["an empty employeeSub", { scenarioId: "inc-104", employeeSub: "" }],
    ["a non-string employeeSub", { scenarioId: "inc-104", employeeSub: 7 }],
    ["an uppercase scenarioId", { scenarioId: "INC-104", employeeSub: PEOPLE.empA.sub }],
  ])("rejects %s", async (_name, body) => {
    expect((await post(body)).status).toBe(400);
    noAssignments();
  });

  it("rejects an unknown scenario with 422", async () => {
    const r = await post({ scenarioId: "inc-999", employeeSub: PEOPLE.empA.sub });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("UNKNOWN_SCENARIO");
  });

  it("rejects missing, malformed and oversized bodies", async () => {
    expect((await api.call({ route: R.create, as: PEOPLE.mgrA, params: { orgId: ORG } })).status).toBe(400);
    expect((await api.call({ route: R.create, as: PEOPLE.mgrA, params: { orgId: ORG }, rawBody: "{nope" })).status).toBe(400);
    const big = JSON.stringify({ scenarioId: "inc-104", employeeSub: "a".repeat(5000) });
    expect((await api.call({ route: R.create, as: PEOPLE.mgrA, params: { orgId: ORG }, rawBody: big })).status).toBe(413);
    noAssignments();
  });

  it("rejects a malformed organization id in the URL", async () => {
    const r = await api.call({
      route: R.create, as: PEOPLE.mgrA, params: { orgId: "ORG#evil" },
      body: { scenarioId: "inc-104", employeeSub: PEOPLE.empA.sub },
    });
    expect(r.status).toBe(404);
  });
});

describe("POST assignments: retries and idempotency", () => {
  it("returns the existing assignment on a retry: 200, created=false, same id, one record", async () => {
    const first = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    api.tick(30);
    const retry = await assign(api, PEOPLE.mgrA, PEOPLE.empA);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.created).toBe(false);
    expect(retry.body.assignment.assignmentId).toBe(first.body.assignment.assignmentId);
    expect(retry.body.assignment.createdAt).toBe(first.body.assignment.createdAt); // not rewritten
    expect(api.db.all(CORE).filter((i) => String(i["PK"]).startsWith("ASSIGN#"))).toHaveLength(1);
  });

  it("two simultaneous requests produce exactly one assignment", async () => {
    const [a, b] = await Promise.all([assign(api, PEOPLE.mgrA, PEOPLE.empA), assign(api, PEOPLE.mgrA, PEOPLE.empA)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.assignment.assignmentId).toBe(b.body.assignment.assignmentId);
    expect(api.db.all(CORE).filter((i) => String(i["PK"]).startsWith("ASSIGN#"))).toHaveLength(1);
  });

  it("an admin re-assigning the same employee gets the existing assignment, not a second one", async () => {
    const first = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    const again = await assign(api, PEOPLE.admin, PEOPLE.empA);
    expect(again.body.assignment.assignmentId).toBe(first.body.assignment.assignmentId);
    expect(again.body.created).toBe(false);
  });

  it("does not reset an assignment that has already progressed", async () => {
    const first = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    const key = { PK: `ASSIGN#${first.body.assignment.assignmentId}`, SK: "META" };
    api.db.put(CORE, { ...api.db.get(CORE, key)!, status: "IN_PROGRESS", sessionId: "ses_" + "a".repeat(32), startedAt: "2026-11-07T10:01:00.000Z" });
    const retry = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    expect(retry.body.assignment.status).toBe("IN_PROGRESS");
  });

  it("assigns the same scenario to different employees independently", async () => {
    const a = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    const b = await assign(api, PEOPLE.mgrA, PEOPLE.empA2);
    expect(a.body.assignment.assignmentId).not.toBe(b.body.assignment.assignmentId);
  });
});

describe("GET assignments: role-specific, owner-scoped lists", () => {
  it("an employee sees only their own assignments, without manager details", async () => {
    await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    await assign(api, PEOPLE.mgrA, PEOPLE.empA2);

    const mine = await listAs(PEOPLE.empA);
    expect(mine.status).toBe(200);
    expect(mine.body.assignments).toHaveLength(1);
    expect(mine.body.assignments[0]).not.toHaveProperty("employee");
    expect(mine.raw).not.toContain(PEOPLE.mgrA.sub);
    expect(mine.raw).not.toContain(PEOPLE.empA2.sub);
  });

  it("a different employee sees nothing of someone else's assignment", async () => {
    await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    expect((await listAs(PEOPLE.empA2)).body.assignments).toEqual([]);
    expect((await listAs(PEOPLE.empB)).body.assignments).toEqual([]);
  });

  it("a manager sees the assignments they created, with the employee shown", async () => {
    await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    const r = await listAs(PEOPLE.mgrA);
    expect(r.body.assignments).toHaveLength(1);
    expect(r.body.assignments[0].employee).toEqual({ userSub: PEOPLE.empA.sub, displayName: "employee" });
  });

  it("another manager does not see this manager's assignments", async () => {
    await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    expect((await listAs(PEOPLE.mgrB)).body.assignments).toEqual([]);
  });

  it("an org admin sees what they created, not everything", async () => {
    await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    expect((await listAs(PEOPLE.admin)).body.assignments).toEqual([]);
    await assign(api, PEOPLE.admin, PEOPLE.empB);
    expect((await listAs(PEOPLE.admin)).body.assignments).toHaveLength(1);
  });

  it("lists newest first", async () => {
    await assign(api, PEOPLE.mgrA, PEOPLE.empA); api.tick(60);
    await assign(api, PEOPLE.mgrA, PEOPLE.empA2);
    const names = (await listAs(PEOPLE.mgrA)).body.assignments.map((a: any) => a.employee.userSub);
    expect(names).toEqual([PEOPLE.empA2.sub, PEOPLE.empA.sub]);
  });

  it("never returns internal keys, index attributes, or the assigning manager's identity", async () => {
    await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    for (const who of [PEOPLE.empA, PEOPLE.mgrA]) {
      const r = await listAs(who);
      expect(r.raw).not.toMatch(/GSI[12]|"PK"|"SK"|assignedBySub|entityType|secret\.example/);
    }
  });

  it("denies a user from another organization and an unauthenticated caller", async () => {
    await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    expect((await listAs(PEOPLE.otherEmp)).status).toBe(404);
    expect((await api.call({ route: R.list, noAuthorizer: true, params: { orgId: ORG } })).status).toBe(401);
    expect((await api.call({ route: R.list, as: PEOPLE.empA, tokenUse: "id", params: { orgId: ORG } })).status).toBe(401);
  });

  it("queries the GSIs (never a Scan, never a consistent read on an index)", async () => {
    await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    await listAs(PEOPLE.empA);
    await listAs(PEOPLE.mgrA);
    const idx = api.db.sent.filter((c) => c.command === "Query").map((c) => c.index);
    expect(idx).toEqual(["GSI1", "GSI2"]);
  });

  it("skips malformed or foreign records in a partition instead of returning them", async () => {
    const good = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    const base = api.db.get(CORE, { PK: `ASSIGN#${good.body.assignment.assignmentId}`, SK: "META" })!;
    // 1) Garbage planted in empA's GSI1 partition.
    api.db.put(CORE, { PK: "ASSIGN#junk", SK: "META", GSI1PK: base["GSI1PK"], GSI1SK: "ASSIGN#9999#junk", note: "not an assignment" });
    // 2) A record whose index key claims empA but whose content belongs to empA2 (tampered).
    api.db.put(CORE, {
      ...base, PK: "ASSIGN#asg_" + "b".repeat(32), assignmentId: "asg_" + "b".repeat(32),
      employeeSub: PEOPLE.empA2.sub, GSI1SK: "ASSIGN#9998#x",
    });
    const r = await listAs(PEOPLE.empA);
    expect(r.body.assignments.map((a: any) => a.assignmentId)).toEqual([good.body.assignment.assignmentId]);
  });
});

describe("failure handling", () => {
  it("a DynamoDB failure yields a generic 500 with no internals and writes nothing", async () => {
    api.db.fail = (cmd) =>
      cmd === "Put" ? new Error("ProvisionedThroughputExceeded for arn:aws:dynamodb:us-east-1:123456789012:table/test-core") : null;
    const r = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ code: "INTERNAL_ERROR", message: "An unexpected error occurred", requestId: expect.any(String) });
    expect(r.raw).not.toMatch(/arn:|test-core|Provisioned/);
    expect(api.db.all(CORE).some((i) => String(i["PK"]).startsWith("ASSIGN#"))).toBe(false);
  });
});
