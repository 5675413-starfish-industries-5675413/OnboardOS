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
import type { RunnerRequest } from "@onboardos/scenario-engine";
import { runnerHandler } from "@onboardos/test-runner";
import { handleRequest } from "../handler.js";
import type { ApiDeps } from "../deps.js";
import type { RunnerClient, RunnerInvocation } from "../runner.js";
import type { BedrockProvider, CoworkerReply, CoworkerRequest } from "../bedrock.js";
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

/**
 * TEST-ONLY runner: invokes the REAL runner handler in-process and returns what a
 * Lambda Invoke would (a JSON round trip, a FunctionError on throw). This is a
 * stand-in for the network hop, not for the suite: the cases genuinely execute.
 * It exists only in tests -- production code never imports the runner package.
 */
export function inProcessRunner(): RunnerClient {
  let n = 0;
  return {
    async invoke(request: RunnerRequest): Promise<RunnerInvocation> {
      n += 1;
      const wire = JSON.parse(JSON.stringify(request)) as unknown; // what crosses the Invoke boundary
      try {
        const out = await runnerHandler(wire, { awsRequestId: `runner-req-${n}` });
        return { payload: JSON.parse(JSON.stringify(out)), functionError: null, invokeRequestId: `invoke-req-${n}` };
      } catch (e) {
        return { payload: { errorMessage: String(e) }, functionError: "Unhandled", invokeRequestId: `invoke-req-${n}` };
      }
    },
  };
}

/** TEST-ONLY model provider. Never makes a network call; records every request it is asked to send. */
export interface FakeCoworker extends BedrockProvider {
  calls: CoworkerRequest[];
  /** Replace what the next calls do. */
  behave: (fn: (req: CoworkerRequest, n: number) => Promise<CoworkerReply>) => void;
}

export const COWORKER_MODEL = "amazon.nova-micro-v1:0";

export function replyOf(text: string, over: Partial<CoworkerReply> = {}): CoworkerReply {
  return {
    text, modelId: COWORKER_MODEL, inputTokens: 120, outputTokens: 30, requestId: "bedrock-req-1",
    stopReason: "end_turn", latencyMs: 210, truncated: false, ...over,
  };
}

export function fakeCoworker(): FakeCoworker {
  let behavior: (req: CoworkerRequest, n: number) => Promise<CoworkerReply> = async (_r, n) =>
    replyOf(`Fake coworker reply ${n}: compare the upstream latency with the timeout.`, { requestId: `bedrock-req-${n}` });
  const calls: CoworkerRequest[] = [];
  return {
    modelId: COWORKER_MODEL,
    calls,
    behave: (fn) => { behavior = fn; },
    converse: async (req) => {
      calls.push(structuredClone(req));
      return behavior(req, calls.length);
    },
  };
}

export interface Api {
  db: FakeDynamo;
  /** The fake model provider currently installed (null when the feature is disabled). */
  coworker: FakeCoworker | null;
  /** Install a provider, or null to model a deployment with no model configured. */
  useCoworker: (p: FakeCoworker | null) => void;
  deps: ApiDeps;
  /** Every request the API sent to the runner (after being recorded, delegated to the active runner). */
  runnerCalls: RunnerRequest[];
  /** Swap the runner implementation (e.g. one that times out or lies). */
  useRunner: (client: RunnerClient) => void;
  /** Make deps.runner() itself throw, as an unconfigured deployment does. */
  breakRunnerConfig: () => void;
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
export function createApi(existing?: FakeDynamo, runnerImpl?: RunnerClient): Api {
  const db = existing ?? new FakeDynamo();
  let clock = Date.parse("2026-11-07T10:00:00.000Z");
  let active: RunnerClient = runnerImpl ?? inProcessRunner();
  let broken = false;
  let cow: FakeCoworker | null = fakeCoworker();
  let idCounter = 0;
  const runnerCalls: RunnerRequest[] = [];
  const deps: ApiDeps = {
    db: { client: db as unknown as ApiDeps["db"]["client"], coreTable: CORE, eventsTable: EVENTS },
    now: () => new Date(clock).toISOString(),
    coworker: () => cow,
    newId: () => (++idCounter).toString(16).padStart(12, "0"),
    runner: () => {
      if (broken) throw new Error("ONBOARDOS_RUNNER_FUNCTION_NAME must be set");
      return {
        invoke: (request) => {
          runnerCalls.push(structuredClone(request));
          return active.invoke(request);
        },
      };
    },
  };
  if (!existing) seedDirectory(db);

  const ctx = (id: string): Context => ({
    awsRequestId: id, functionName: "api", functionVersion: "$LATEST",
    invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:api", memoryLimitInMB: "512",
    logGroupName: "g", logStreamName: "s", callbackWaitsForEmptyEventLoop: false,
    getRemainingTimeInMillis: () => 29000, done: () => {}, fail: () => {}, succeed: () => {},
  });

  let n = 0;
  const api: Api = {
    db,
    deps,
    get coworker() { return cow; },
    useCoworker: (p) => { cow = p; },
    runnerCalls,
    useRunner: (c) => { active = c; },
    breakRunnerConfig: () => { broken = true; },
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
  return api;
}

// -- route shortcuts ----------------------------------------------------------
export const R = {
  messages: "GET /v1/sessions/{sessionId}/messages",
  ask: "POST /v1/sessions/{sessionId}/messages",
  employees: "GET /v1/orgs/{orgId}/assignable-employees",
  list: "GET /v1/orgs/{orgId}/assignments",
  create: "POST /v1/orgs/{orgId}/assignments",
  start: "POST /v1/assignments/{assignmentId}/start",
  session: "GET /v1/sessions/{sessionId}",
  action: "POST /v1/sessions/{sessionId}/actions",
  saveConfig: "PUT /v1/sessions/{sessionId}/config",
  runTests: "POST /v1/sessions/{sessionId}/test-runs",
  getRun: "GET /v1/sessions/{sessionId}/test-runs/{runId}",
  submit: "POST /v1/sessions/{sessionId}/submissions",
  review: "GET /v1/reviews/{submissionId}",
  decide: "POST /v1/reviews/{submissionId}/decision",
  coachScenarios: "GET /v1/orgs/{orgId}/scenarios",
  coachStudio: "GET /v1/orgs/{orgId}/scenarios/{scenarioId}/coaching",
  coachSave: "PUT /v1/orgs/{orgId}/scenarios/{scenarioId}/coaching/draft",
  coachValidate: "POST /v1/orgs/{orgId}/scenarios/{scenarioId}/coaching/validate",
  coachPublish: "POST /v1/orgs/{orgId}/scenarios/{scenarioId}/coaching/publish",
  coachVersion: "GET /v1/orgs/{orgId}/scenarios/{scenarioId}/coaching/versions/{profileVersion}",
} as const;

export const assign = (api: Api, by: Person, employee: Person, org = ORG) =>
  api.call({ route: R.create, as: by, params: { orgId: org }, body: { scenarioId: "inc-104", employeeSub: employee.sub } });

export const startAs = (api: Api, who: Person | string, assignmentId: string) =>
  api.call({ route: R.start, as: who, params: { assignmentId } });

export const act = (api: Api, who: Person | string, sessionId: string, expectedStateVersion: number, action: unknown) =>
  api.call({ route: R.action, as: who, params: { sessionId }, body: { expectedStateVersion, action } });

export const saveConfig = (api: Api, who: Person | string, sessionId: string, expectedStateVersion: number, ms: unknown) =>
  api.call({ route: R.saveConfig, as: who, params: { sessionId }, body: { expectedStateVersion, config: { request_timeout_ms: ms } } });

export const runTests = (api: Api, who: Person | string, sessionId: string, expectedStateVersion: number) =>
  api.call({ route: R.runTests, as: who, params: { sessionId }, body: { expectedStateVersion } });

export const getRun = (api: Api, who: Person | string, sessionId: string, runId: string) =>
  api.call({ route: R.getRun, as: who, params: { sessionId, runId } });

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

// -- Phase 2D helpers -----------------------------------------------------------

export const REPORT = {
  rootCause: "The checkout client timeout of 800 ms is shorter than the payments upstream's slow responses.",
  correctiveAction: "Raised request_timeout_ms so slow upstream responses complete before the client gives up.",
  verification: "Saved the new revision and ran the predefined test suite on AWS Lambda against it.",
  remainingRisks: "A longer timeout can hold connections open longer; monitor saturation and upstream latency.",
} as const;

let keyCounter = 0;
/** A fresh, valid Idempotency-Key. */
export const newKey = (): string => `key-${String(++keyCounter).padStart(6, "0")}-abcdef`;

export interface SubmitOverrides {
  key?: string | null;
  expectedStateVersion?: number;
  testRunId?: string;
  configRevision?: number;
  configHash?: string;
  report?: unknown;
  extra?: Record<string, unknown>;
}

/**
 * Submit as the employee, building the request from what the employee's own page shows (the
 * session read back from the API). Overrides let tests forge any part of it.
 */
export async function submitReport(api: Api, who: Person | string, sessionId: string, o: SubmitOverrides = {}) {
  const view = (await api.call({ route: R.session, as: who, params: { sessionId } })).body?.session;
  const body = {
    expectedStateVersion: o.expectedStateVersion ?? view?.stateVersion ?? 0,
    testRunId: o.testRunId ?? view?.currentEvidence?.testRunId ?? "run_0001_000000000000",
    configRevision: o.configRevision ?? view?.configRevision ?? 0,
    configHash: o.configHash ?? view?.configHash ?? "sha256:" + "0".repeat(64),
    report: o.report ?? REPORT,
    ...o.extra,
  };
  const key = o.key === undefined ? newKey() : o.key;
  return api.call({
    route: R.submit,
    as: who,
    params: { sessionId },
    body,
    headers: key === null ? {} : { "idempotency-key": key },
  });
}

export const decide = (api: Api, who: Person | string, submissionId: string, body: unknown) =>
  api.call({ route: R.decide, as: who, params: { submissionId }, body });

export const getReview = (api: Api, who: Person | string, submissionId: string) =>
  api.call({ route: R.review, as: who, params: { submissionId } });

/** Assign, start, save `ms` (unless it is the 800 baseline) and run the tests: a session ready to submit. */
export async function readyToSubmit(
  api: Api,
  ms = 1800,
  employee: Person = PEOPLE.empA,
  manager: Person = PEOPLE.mgrA,
  org = ORG,
) {
  const a = await assign(api, manager, employee, org);
  const assignmentId: string = a.body.assignment.assignmentId;
  const s = await startAs(api, employee, assignmentId);
  const sessionId: string = s.body.session.sessionId;
  let version: number = s.body.session.stateVersion;
  if (ms !== 800) {
    const saved = await saveConfig(api, employee, sessionId, version, ms);
    version = saved.body.session.stateVersion;
  }
  const run = await runTests(api, employee, sessionId, version);
  return { assignmentId, sessionId, run, runId: run.body.testRun.testRunId as string };
}

/**
 * Work on the CURRENT attempt of an existing session until it is submitted: save `ms` (when it differs),
 * run the tests and submit. Returns the submission id.
 */
export async function finishAttempt(api: Api, who: Person, sessionId: string, ms: number): Promise<string> {
  let view = (await api.call({ route: R.session, as: who, params: { sessionId } })).body.session;
  if (view.config.request_timeout_ms !== ms) {
    view = (await saveConfig(api, who, sessionId, view.stateVersion, ms)).body.session;
  }
  const run = await runTests(api, who, sessionId, view.stateVersion);
  if (run.status !== 201) throw new Error(`run failed: ${run.status} ${run.raw}`);
  const sub = await submitReport(api, who, sessionId);
  if (sub.status !== 201) throw new Error(`submit failed: ${sub.status} ${sub.raw}`);
  return sub.body.submission.submissionId as string;
}

// -- Phase 4 helpers ------------------------------------------------------------

export const askCoworker = (api: Api, who: Person | string, sessionId: string, message: unknown, key: string | null = newKey()) =>
  api.call({
    route: R.ask,
    as: who,
    params: { sessionId },
    body: { message },
    headers: key === null ? {} : { "idempotency-key": key },
  });

export const listCoworker = (api: Api, who: Person | string, sessionId: string) =>
  api.call({ route: R.messages, as: who, params: { sessionId } });

/** Assign and start a session for an employee; no tests run. */
export async function startedFor(api: Api, employee: Person = PEOPLE.empA, manager: Person = PEOPLE.mgrA, org = ORG) {
  const a = await assign(api, manager, employee, org);
  const assignmentId: string = a.body.assignment.assignmentId;
  const s = await startAs(api, employee, assignmentId);
  return { assignmentId, sessionId: s.body.session.sessionId as string, session: s.body.session };
}
