import { beforeEach, describe, expect, it } from "vitest";
import { INC_104_V1 } from "@onboardos/scenario-fixtures";
import {
  CORE,
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
  type Api,
  type Req,
  type Res,
} from "./harness.js";

let api: Api;
beforeEach(() => {
  api = createApi();
});

const SOME_ASSIGNMENT = "asg_" + "a".repeat(32);
const SOME_SESSION = "ses_" + "a".repeat(32);

/** Every protected route introduced in Phase 2B, with a plausible request shape. */
const PROTECTED: Array<{ name: string; req: Omit<Req, "as" | "tokenUse" | "noAuthorizer"> }> = [
  { name: "list assignable employees", req: { route: R.employees, params: { orgId: ORG } } },
  { name: "list assignments", req: { route: R.list, params: { orgId: ORG } } },
  {
    name: "create assignment",
    req: { route: R.create, params: { orgId: ORG }, body: { scenarioId: "inc-104", employeeSub: PEOPLE.empA.sub } },
  },
  { name: "start assignment", req: { route: R.start, params: { assignmentId: SOME_ASSIGNMENT } } },
  { name: "get session", req: { route: R.session, params: { sessionId: SOME_SESSION } } },
  {
    name: "session action",
    req: { route: R.action, params: { sessionId: SOME_SESSION }, body: { expectedStateVersion: 0, action: OPEN_TICKET } },
  },
];

describe("authentication on every protected route", () => {
  it.each(PROTECTED)("$name: no authorizer context => 401", async ({ req }) => {
    const r = await api.call({ ...req, noAuthorizer: true });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("UNAUTHORIZED");
  });

  it.each(PROTECTED)("$name: an ID token (token_use=id) is rejected => 401", async ({ req }) => {
    const r = await api.call({ ...req, as: PEOPLE.mgrA, tokenUse: "id" });
    expect(r.status).toBe(401);
  });

  it.each(PROTECTED)("$name: a token with no token_use claim => 401", async ({ req }) => {
    const r = await api.call({ ...req, as: PEOPLE.mgrA, tokenUse: "" });
    expect(r.status).toBe(401);
  });

  it.each(PROTECTED)("$name: claims without a subject => 401", async ({ req }) => {
    const r = await api.call({ ...req, as: undefined });
    expect(r.status).toBe(401);
  });

  it("does not touch storage for an unauthenticated request", async () => {
    for (const { req } of PROTECTED) await api.call({ ...req, noAuthorizer: true });
    expect(api.db.sent).toHaveLength(0);
  });
});

describe("authorization on every protected route", () => {
  it.each(PROTECTED)("$name: an authenticated user with NO membership anywhere => 404", async ({ req }) => {
    const r = await api.call({ ...req, as: "ghost-sub" });
    expect(r.status).toBe(404);
  });

  it.each(PROTECTED)("$name: a member of ANOTHER organization is denied", async ({ req }) => {
    const r = await api.call({ ...req, as: PEOPLE.otherMgr });
    expect(r.status).toBe(404);
  });

  it("denies a SUSPENDED or malformed membership on the org routes", async () => {
    seedMember(api.db, { sub: "gone", role: "manager", teams: ["team-a"], name: "gone", status: "SUSPENDED" });
    api.db.put(CORE, { PK: `ORG#${ORG}`, SK: "MEMBER#mangled", role: "manager", status: "ACTIVE", teamIds: "team-a" });
    for (const who of ["gone", "mangled"]) {
      expect((await api.call({ route: R.employees, as: who, params: { orgId: ORG } })).status).toBe(404);
      expect((await api.call({ route: R.list, as: who, params: { orgId: ORG } })).status).toBe(404);
    }
  });
});

describe("roles come from DynamoDB only: forged client input grants nothing", () => {
  const managerOnly = [
    { name: "assignable employees", req: { route: R.employees, params: { orgId: ORG } } as Req },
    {
      name: "create assignment",
      req: { route: R.create, params: { orgId: ORG }, body: { scenarioId: "inc-104", employeeSub: PEOPLE.empA2.sub } } as Req,
    },
  ];

  it.each(managerOnly)("$name: role claims in the token do not elevate an employee", async ({ req }) => {
    const r = await api.call({
      ...req, as: PEOPLE.empA,
      extraClaims: { role: "org_admin", "custom:role": "manager", "cognito:groups": "admins,managers", scope: "admin" },
    });
    expect(r.status).toBe(403);
  });

  it.each(managerOnly)("$name: role headers and query parameters do not elevate an employee", async ({ req }) => {
    const r = await api.call({
      ...req, as: PEOPLE.empA,
      headers: { "x-role": "org_admin", "x-user-role": "manager", "x-organization-id": ORG },
      query: { role: "org_admin", asRole: "manager" },
    });
    expect(r.status).toBe(403);
  });

  it("a role change in DynamoDB takes effect on the next request, with the same token", async () => {
    const before = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    expect(before.status).toBe(201);

    seedMember(api.db, { ...PEOPLE.mgrA, role: "employee" }); // demoted in the database
    const after = await assign(api, PEOPLE.mgrA, PEOPLE.empA2);
    expect(after.status).toBe(403);
  });

  it("an employee cannot claim a manager's identity by putting their sub in the request", async () => {
    // The body carries an employee sub; the assigner is always the token's subject.
    const r = await api.call({
      route: R.create, as: PEOPLE.empA, params: { orgId: ORG },
      body: { scenarioId: "inc-104", employeeSub: PEOPLE.empA2.sub },
      headers: { "x-manager-sub": PEOPLE.mgrA.sub },
    });
    expect(r.status).toBe(403);
  });

  it("an employee cannot read another employee's assignments or session by supplying their ids", async () => {
    const a = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    const id = a.body.assignment.assignmentId;
    const s = await startAs(api, PEOPLE.empA, id);
    const sid = s.body.session.sessionId;

    expect((await api.call({ route: R.list, as: PEOPLE.empA2, params: { orgId: ORG }, query: { employeeSub: PEOPLE.empA.sub } })).body.assignments).toEqual([]);
    expect((await startAs(api, PEOPLE.empA2, id)).status).toBe(404);
    expect((await api.call({ route: R.session, as: PEOPLE.empA2, params: { sessionId: sid } })).status).toBe(404);
    expect((await act(api, PEOPLE.empA2, sid, 1, OPEN_TICKET)).status).toBe(404);
  });
});

describe("data exposure: nothing hidden, internal, or manager-only leaves the API", () => {
  /** Drive the complete workflow and collect every response. */
  async function workflow(): Promise<Res[]> {
    const out: Res[] = [];
    out.push(await api.call({ route: R.employees, as: PEOPLE.mgrA, params: { orgId: ORG } }));
    const a = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    out.push(a);
    out.push(await assign(api, PEOPLE.mgrA, PEOPLE.empA)); // retry
    out.push(await api.call({ route: R.list, as: PEOPLE.mgrA, params: { orgId: ORG } }));
    out.push(await api.call({ route: R.list, as: PEOPLE.empA, params: { orgId: ORG } }));
    const s = await startAs(api, PEOPLE.empA, a.body.assignment.assignmentId);
    out.push(s);
    const sid = s.body.session.sessionId;
    out.push(await act(api, PEOPLE.empA, sid, 1, OPEN_TICKET));
    out.push(await act(api, PEOPLE.empA, sid, 2, OPEN_RUNBOOK));
    out.push(await act(api, PEOPLE.empA, sid, 3, OPEN_DIAGNOSTICS));
    out.push(await api.call({ route: R.session, as: PEOPLE.empA, params: { sessionId: sid } }));
    return out;
  }

  it("never returns emails, index keys, entity types, suite ids or rubric data", async () => {
    for (const r of await workflow()) {
      expect(r.raw).not.toMatch(/secret\.example|GSI[12]|"PK"|"SK"|entityType|assignedBySub|testSuite|rubric/i);
      expect(r.raw).not.toContain(INC_104_V1.testSuiteId);
    }
  });

  it("never shows the employee the assigning manager's identity", async () => {
    const employeeFacing = (await workflow()).filter((_r, i) => [4, 5, 6, 7, 8, 9].includes(i));
    for (const r of employeeFacing) expect(r.raw).not.toContain(PEOPLE.mgrA.sub);
  });

  it("the employee-facing session contains only contract fields (no extra top-level keys)", async () => {
    const res = await workflow();
    const session = res[9]!.body.session;
    expect(Object.keys(session).sort()).toEqual(
      [
        "activeTestRunId", "assignmentId", "attemptNumber", "config", "configHash", "configRevision", "currentEvidence", "organizationId",
        "phase", "revisions", "scenario", "scenarioId", "scenarioVersion", "sessionId", "startedAt", "stateVersion",
        "submission", "submissions", "testRuns", "updatedAt", "viewed",
      ].sort(),
    );
    expect(Object.keys(session.scenario).sort()).toEqual(
      ["diagnostics", "initialConfig", "runbook", "scenarioId", "summary", "ticket", "title", "version"].sort(),
    );
  });

  it("every error response has exactly { code, message, requestId } and no internals", async () => {
    const errors: Res[] = [
      await api.call({ route: R.list, noAuthorizer: true, params: { orgId: ORG } }),
      await api.call({ route: R.list, as: "ghost-sub", params: { orgId: ORG } }),
      await api.call({ route: R.employees, as: PEOPLE.empA, params: { orgId: ORG } }),
      await api.call({ route: R.create, as: PEOPLE.mgrA, params: { orgId: ORG }, body: { nope: 1 } }),
      await api.call({ route: R.create, as: PEOPLE.mgrA, params: { orgId: ORG }, body: { scenarioId: "zzz", employeeSub: PEOPLE.empA.sub } }),
      await api.call({ route: R.session, as: PEOPLE.empA, params: { sessionId: SOME_SESSION } }),
      await api.call({ route: "DELETE /v1/sessions/{sessionId}", as: PEOPLE.empA, params: { sessionId: SOME_SESSION } }),
    ];
    for (const e of errors) {
      expect(e.status).toBeGreaterThanOrEqual(400);
      expect(Object.keys(e.body).sort()).toEqual(["code", "message", "requestId"]);
      expect(e.raw).not.toMatch(/arn:|test-core|test-events|stack|at .*\.ts|node_modules/i);
    }
  });

  it("marks every authenticated response non-cacheable", async () => {
    for (const r of await workflow()) expect(r.headers["Cache-Control"]).toBe("no-store");
  });
});

describe("integrity of server-owned data", () => {
  it("never mutates the published scenario", async () => {
    const before = JSON.stringify(INC_104_V1);
    const a = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    const s = await startAs(api, PEOPLE.empA, a.body.assignment.assignmentId);
    await act(api, PEOPLE.empA, s.body.session.sessionId, 1, OPEN_TICKET);
    expect(JSON.stringify(INC_104_V1)).toBe(before);
    expect(INC_104_V1.content.initialConfig).toEqual({ request_timeout_ms: 800 });
  });

  it("records the VERIFIED subject as the event actor, whatever the request says", async () => {
    const a = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    const s = await startAs(api, PEOPLE.empA, a.body.assignment.assignmentId);
    await api.call({
      route: R.action, as: PEOPLE.empA, params: { sessionId: s.body.session.sessionId },
      body: { expectedStateVersion: 1, action: OPEN_TICKET },
      headers: { "x-actor": PEOPLE.mgrA.sub }, query: { actorSub: PEOPLE.mgrA.sub },
    });
    for (const e of api.db.all("test-events")) expect(e["actorSub"]).toBe(PEOPLE.empA.sub);
  });

  it("never issues a table Scan or an unscoped query across the whole workflow", async () => {
    const a = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
    const s = await startAs(api, PEOPLE.empA, a.body.assignment.assignmentId);
    await act(api, PEOPLE.empA, s.body.session.sessionId, 1, OPEN_TICKET);
    await api.call({ route: R.list, as: PEOPLE.empA, params: { orgId: ORG } });
    await api.call({ route: R.employees, as: PEOPLE.admin, params: { orgId: ORG } });
    const commands = new Set(api.db.sent.map((c) => c.command));
    expect([...commands].every((c) => ["Get", "Put", "Query", "TransactWrite"].includes(c))).toBe(true);
    // Every Query is either an index query or a single-partition member listing.
    for (const q of api.db.sent.filter((c) => c.command === "Query")) {
      expect([undefined, "GSI1", "GSI2"]).toContain(q.index);
    }
  });
});

describe("routing", () => {
  it("keeps /health public and responding without any authorizer context", async () => {
    const r = await api.call({ route: "GET /health", noAuthorizer: true });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
  });

  it.each([
    "DELETE /v1/sessions/{sessionId}",
    "PUT /v1/sessions/{sessionId}",
    "GET /v1/sessions/{sessionId}/actions",
    "GET /v1/assignments/{assignmentId}/start",
    "PATCH /v1/orgs/{orgId}/assignments",
    "GET /v1/admin",
  ])("does not route %s", async (route) => {
    const r = await api.call({ route, as: PEOPLE.admin, params: { orgId: ORG, sessionId: SOME_SESSION, assignmentId: SOME_ASSIGNMENT } });
    expect(r.status).toBe(404);
  });
});
