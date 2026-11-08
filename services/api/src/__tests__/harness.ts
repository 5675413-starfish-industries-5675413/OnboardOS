/**
 * Test harness for the Phase 2B routes.
 *
 * Drives the REAL router (handleRequest) and REAL route/authorization/engine
 * code against an in-memory DynamoDB and a deterministic clock. Identity is
 * supplied the way API Gateway supplies it: as verified JWT claims on the
 * request context. (These are Lambda-unit tests: JWT signature/expiry checks
 * are done by API Gateway and are verified only in a deployed environment.)
 */

import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { handleRequest } from "../handler.js";
import type { ApiDeps } from "../deps.js";
import { FakeDynamo } from "./fakeDynamo.js";

export const CORE = "test-core";
export const EVENTS = "test-events";
export const ORG = "northstar-cloud";
export const OTHER_ORG = "other-corp";

export interface Person {
  sub: string;
  role: "org_admin" | "manager" | "employee";
  teams: string[];
  name: string;
  status?: "ACTIVE" | "SUSPENDED" | "INVITED";
  org?: string;
}

/** A realistic directory: two teams, a suspended employee, and a second tenant. */
export const PEOPLE = {
  admin: { sub: "admin-sub", role: "org_admin", teams: [], name: "admin" },
  mgrA: { sub: "mgr-a-sub", role: "manager", teams: ["team-a"], name: "manager" },
  mgrB: { sub: "mgr-b-sub", role: "manager", teams: ["team-b"], name: "manager-b" },
  empA: { sub: "emp-a-sub", role: "employee", teams: ["team-a"], name: "employee" },
  empA2: { sub: "emp-a2-sub", role: "employee", teams: ["team-a"], name: "employee-two" },
  empB: { sub: "emp-b-sub", role: "employee", teams: ["team-b"], name: "employee-b" },
  empSuspended: { sub: "emp-susp-sub", role: "employee", teams: ["team-a"], name: "suspended", status: "SUSPENDED" },
  otherMgr: { sub: "other-mgr-sub", role: "manager", teams: ["team-a"], name: "other-mgr", org: OTHER_ORG },
  otherEmp: { sub: "other-emp-sub", role: "employee", teams: ["team-a"], name: "other-emp", org: OTHER_ORG },
} satisfies Record<string, Person>;

export function seedMember(db: FakeDynamo, p: Person): void {
  const org = p.org ?? ORG;
  db.put(CORE, {
    PK: `ORG#${org}`,
    SK: `MEMBER#${p.sub}`,
    organizationId: org,
    userSub: p.sub,
    role: p.role,
    status: p.status ?? "ACTIVE",
    teamIds: p.teams,
    email: `${p.name}@secret.example`, // must never appear in any response
    preferredUsername: p.name,
  });
}

export function seedDirectory(db: FakeDynamo): void {
  for (const p of Object.values(PEOPLE) as Person[]) seedMember(db, p);
}

export interface Api {
  db: FakeDynamo;
  deps: ApiDeps;
  /** Advance the deterministic clock by n seconds. */
  tick: (seconds?: number) => void;
  call: (req: Req) => Promise<Res>;
}

export interface Req {
  route: string;
  /** Verified subject. Omit together with `noAuthorizer` to simulate no authorizer context. */
  as?: Person | string;
  tokenUse?: string;
  noAuthorizer?: boolean;
  params?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  /** Hostile extras a client might send; the server must ignore/reject them. */
  headers?: Record<string, string>;
  query?: Record<string, string>;
  extraClaims?: Record<string, string>;
}

export interface Res {
  status: number;
  body: any;
  headers: Record<string, string>;
  raw: string;
}

/**
 * Pass an existing store to model a fresh Lambda instance (new process, new
 * clock) talking to data persisted by an earlier one.
 */
export function createApi(existing?: FakeDynamo): Api {
  const db = existing ?? new FakeDynamo();
  let clock = Date.parse("2026-11-07T10:00:00.000Z");
  const deps: ApiDeps = {
    db: { client: db as unknown as ApiDeps["db"]["client"], coreTable: CORE, eventsTable: EVENTS },
    now: () => new Date(clock).toISOString(),
  };
  if (!existing) seedDirectory(db);

  const ctx = (id: string): Context => ({
    awsRequestId: id, functionName: "api", functionVersion: "$LATEST",
    invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:api", memoryLimitInMB: "512",
    logGroupName: "g", logStreamName: "s", callbackWaitsForEmptyEventLoop: false,
    getRemainingTimeInMillis: () => 29000, done: () => {}, fail: () => {}, succeed: () => {},
  });

  let n = 0;
  return {
    db,
    deps,
    tick: (s = 1) => { clock += s * 1000; },
    call: async (req) => {
      const sub = typeof req.as === "string" ? req.as : req.as?.sub;
      const [method, path] = req.route.split(" ") as [string, string];
      const claims: Record<string, string> = {
        ...(sub ? { sub } : {}),
        token_use: req.tokenUse ?? "access",
        ...req.extraClaims,
      };
      const requestContext: Record<string, unknown> = {
        http: { method, path, protocol: "HTTP/1.1", sourceIp: "203.0.113.9", userAgent: "test" },
        accountId: "123456789012", apiId: "api", domainName: "d", domainPrefix: "d",
        requestId: `req-${++n}`, routeKey: req.route, stage: "$default", time: "", timeEpoch: 0,
        ...(req.noAuthorizer ? {} : { authorizer: { jwt: { claims, scopes: [] } } }),
      };
      const event = {
        version: "2.0",
        routeKey: req.route,
        rawPath: path,
        rawQueryString: "",
        headers: req.headers ?? {},
        queryStringParameters: req.query,
        pathParameters: req.params,
        requestContext,
        body: req.rawBody ?? (req.body === undefined ? undefined : JSON.stringify(req.body)),
        isBase64Encoded: false,
      } as unknown as APIGatewayProxyEventV2;

      const out = await handleRequest(event, ctx(`lambda-${n}`), () => deps);
      return { status: out.statusCode, body: out.body ? JSON.parse(out.body) : undefined, headers: out.headers, raw: out.body };
    },
  };
}

// -- route shortcuts ----------------------------------------------------------
export const R = {
  employees: "GET /v1/orgs/{orgId}/assignable-employees",
  list: "GET /v1/orgs/{orgId}/assignments",
  create: "POST /v1/orgs/{orgId}/assignments",
  start: "POST /v1/assignments/{assignmentId}/start",
  session: "GET /v1/sessions/{sessionId}",
  action: "POST /v1/sessions/{sessionId}/actions",
} as const;

export const assign = (api: Api, by: Person, employee: Person, org = ORG) =>
  api.call({ route: R.create, as: by, params: { orgId: org }, body: { scenarioId: "inc-104", employeeSub: employee.sub } });

export const startAs = (api: Api, who: Person | string, assignmentId: string) =>
  api.call({ route: R.start, as: who, params: { assignmentId } });

export const act = (api: Api, who: Person | string, sessionId: string, expectedStateVersion: number, action: unknown) =>
  api.call({ route: R.action, as: who, params: { sessionId }, body: { expectedStateVersion, action } });

export const OPEN_TICKET = { type: "OPEN_TICKET", ticketId: "INC-104" } as const;
export const OPEN_RUNBOOK = { type: "OPEN_RUNBOOK", runbookId: "RB-CHECKOUT-TIMEOUT" } as const;
export const OPEN_DIAGNOSTICS = { type: "OPEN_DIAGNOSTICS", diagnosticsId: "DIAG-INC-104" } as const;

/** Assign (as manager A) and start (as employee A); returns the ids. */
export async function startedSession(api: Api) {
  const a = await assign(api, PEOPLE.mgrA, PEOPLE.empA);
  const assignmentId: string = a.body.assignment.assignmentId;
  const s = await startAs(api, PEOPLE.empA, assignmentId);
  return { assignmentId, sessionId: s.body.session.sessionId as string, session: s.body.session, startRes: s };
}
