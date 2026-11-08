import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ApiError,
  createAssignment,
  fetchCoworker,
  fetchReview,
  fetchSession,
  fetchTestRun,
  getMe,
  listAssignableEmployees,
  listAssignments,
  postSessionAction,
  postReviewDecision,
  requestTestRun,
  saveConfig,
  sendCoworkerMessage,
  startAssignment,
  submitReport,
} from "../lib/api.js";
import { getSession } from "../lib/auth.js";
import { setupBrowserEnv, signIn, type FakeStorage } from "./helpers.js";

let storage: FakeStorage;
const fetchMock = vi.fn();

const VALID_ME = {
  userSub: "sub-123",
  username: "sub-123",
  memberships: [
    {
      organizationId: "northstar-cloud",
      organizationName: "Northstar Cloud",
      role: "employee",
      status: "ACTIVE",
      teamIds: ["cloud-team-1"],
    },
  ],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  ({ storage } = setupBrowserEnv());
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("getMe", () => {
  it("calls GET /v1/me with the access token as a Bearer credential", async () => {
    signIn(storage, "my-access-token");
    fetchMock.mockResolvedValue(json(200, VALID_ME));

    const me = await getMe();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/me"); // trailing slash in config handled
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-access-token");
    expect(me.memberships[0]?.role).toBe("employee");
  });

  it("does not call the API at all without a session", async () => {
    await expect(getMe()).rejects.toMatchObject({ status: 401, code: "NO_SESSION" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the session and reports 401 when the API rejects the token", async () => {
    signIn(storage);
    fetchMock.mockResolvedValue(json(401, { message: "Unauthorized" }));

    const err = await getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(getSession()).toBeNull(); // expired/invalid session no longer usable
  });

  it("rejects a response that violates the shared contract (e.g. unknown role)", async () => {
    signIn(storage);
    fetchMock.mockResolvedValue(
      json(200, {
        ...VALID_ME,
        memberships: [{ ...VALID_ME.memberships[0], role: "superadmin" }],
      }),
    );
    await expect(getMe()).rejects.toThrow();
  });

  it("maps a network/CORS failure to a typed error with status 0", async () => {
    signIn(storage);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(getMe()).rejects.toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });

  it("carries the server's error code and message for non-401 failures", async () => {
    signIn(storage);
    fetchMock.mockResolvedValue(
      json(500, { code: "INTERNAL_ERROR", message: "An unexpected error occurred", requestId: "r1" }),
    );
    await expect(getMe()).rejects.toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    });
  });

  it("keeps the session on a non-401 failure", async () => {
    signIn(storage);
    fetchMock.mockResolvedValue(json(500, { code: "INTERNAL_ERROR", message: "x", requestId: "r" }));
    await getMe().catch(() => undefined);
    expect(getSession()).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 2B calls
// ---------------------------------------------------------------------------

const ASSIGNMENT = {
  assignmentId: "asg_" + "a".repeat(32),
  organizationId: "northstar-cloud",
  scenarioId: "inc-104",
  scenarioVersion: 1,
  scenarioTitle: "INC-104: Checkout API timeouts",
  status: "ASSIGNED",
  sessionId: null,
  createdAt: "2026-11-07T10:00:00.000Z",
  startedAt: null,
  attemptNumber: 1,
  latestSubmissionId: null,
};

const SESSION = {
  sessionId: "ses_" + "b".repeat(32),
  assignmentId: ASSIGNMENT.assignmentId,
  organizationId: "northstar-cloud",
  scenarioId: "inc-104",
  scenarioVersion: 1,
  phase: "INVESTIGATING",
  stateVersion: 1,
  config: { request_timeout_ms: 800 },
  configRevision: 0,
  configHash: "sha256:fa812173342a39f8644ec44f9009cbd00be1f92c8a9c97e0d45fb00006bf0386",
  revisions: [],
  testRuns: [],
  currentEvidence: { status: "NONE", testRunId: null },
  activeTestRunId: null,
  attemptNumber: 1,
  submission: null,
  submissions: [],
  viewed: { ticket: false, runbook: false, diagnostics: false },
  startedAt: "2026-11-07T10:00:00.000Z",
  updatedAt: "2026-11-07T10:00:00.000Z",
  scenario: {
    scenarioId: "inc-104", version: 1, title: "INC-104", summary: "s",
    ticket: {
      id: "INC-104", title: "t", severity: "SEV2", status: "OPEN", service: "svc",
      reportedAt: "2026-11-06T14:12:00Z", reporter: "r", description: "d", comments: [],
    },
    runbook: { id: "RB-CHECKOUT-TIMEOUT", title: "rb", sections: [] },
    diagnostics: { id: "DIAG-INC-104", title: "d", source: "SYNTHETIC", notice: "n", entries: [] },
    initialConfig: { request_timeout_ms: 800 },
  },
};

function sent(): { url: string; init: RequestInit; headers: Record<string, string>; body: unknown } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return {
    url,
    init,
    headers: init.headers as Record<string, string>,
    body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
}

describe("manager calls", () => {
  beforeEach(() => signIn(storage, "tok"));

  it("createAssignment sends exactly { scenarioId, employeeSub }: no role, organization, manager or status", async () => {
    fetchMock.mockResolvedValue(json(201, { assignment: ASSIGNMENT, created: true }));
    const r = await createAssignment("northstar-cloud", "emp-sub-1");

    const s = sent();
    expect(s.url).toBe("https://api.example.com/v1/orgs/northstar-cloud/assignments");
    expect(s.init.method).toBe("POST");
    expect(s.body).toEqual({ scenarioId: "inc-104", employeeSub: "emp-sub-1" });
    expect(s.headers["Authorization"]).toBe("Bearer tok");
    expect(s.headers["Content-Type"]).toBe("application/json");
    expect(r.created).toBe(true);
    expect(r.assignment.status).toBe("ASSIGNED");
  });

  it("listAssignableEmployees and listAssignments are GETs with no body", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { employees: [{ userSub: "e1", displayName: "Employee", teamIds: ["t"] }] }));
    const emps = await listAssignableEmployees("northstar-cloud");
    expect(sent().url).toBe("https://api.example.com/v1/orgs/northstar-cloud/assignable-employees");
    expect(sent().init.method).toBe("GET");
    expect(sent().body).toBeUndefined();
    expect(emps.employees[0]?.userSub).toBe("e1");

    fetchMock.mockResolvedValueOnce(json(200, { assignments: [ASSIGNMENT] }));
    const list = await listAssignments("northstar-cloud");
    expect(sent().url).toBe("https://api.example.com/v1/orgs/northstar-cloud/assignments");
    expect(list).toHaveLength(1);
  });

  it("URL-encodes path segments so an id can never alter the path", async () => {
    fetchMock.mockResolvedValue(json(200, { assignments: [] }));
    await listAssignments("../admin?x=1#frag");
    expect(sent().url).toBe("https://api.example.com/v1/orgs/..%2Fadmin%3Fx%3D1%23frag/assignments");
  });

  it("rejects a create response that violates the contract (e.g. an unknown status)", async () => {
    fetchMock.mockResolvedValue(json(201, { assignment: { ...ASSIGNMENT, status: "HACKED" }, created: true }));
    await expect(createAssignment("northstar-cloud", "e")).rejects.toThrow();
  });

  it("surfaces server denial codes as typed errors", async () => {
    fetchMock.mockResolvedValue(json(403, { code: "FORBIDDEN", message: "no", requestId: "r" }));
    await expect(createAssignment("northstar-cloud", "e")).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    fetchMock.mockResolvedValue(json(404, { code: "NOT_FOUND", message: "Not found", requestId: "r" }));
    await expect(createAssignment("northstar-cloud", "e")).rejects.toMatchObject({ status: 404 });
  });
});

describe("employee calls", () => {
  beforeEach(() => signIn(storage, "tok"));

  it("startAssignment is a bodyless POST to the assignment's start URL", async () => {
    fetchMock.mockResolvedValue(json(201, { session: SESSION, created: true }));
    const r = await startAssignment(ASSIGNMENT.assignmentId);
    expect(sent().url).toBe(`https://api.example.com/v1/assignments/${ASSIGNMENT.assignmentId}/start`);
    expect(sent().init.method).toBe("POST");
    expect(sent().body).toBeUndefined();
    expect(sent().headers["Content-Type"]).toBeUndefined();
    expect(r.session.stateVersion).toBe(1);
  });

  it("fetchSession returns the validated authoritative session", async () => {
    fetchMock.mockResolvedValue(json(200, { session: SESSION }));
    const s = await fetchSession(SESSION.sessionId);
    expect(sent().url).toBe(`https://api.example.com/v1/sessions/${SESSION.sessionId}`);
    expect(s.config).toEqual({ request_timeout_ms: 800 });
    expect(s.scenario.diagnostics.source).toBe("SYNTHETIC");
  });

  it("postSessionAction sends exactly { expectedStateVersion, action } and nothing else", async () => {
    fetchMock.mockResolvedValue(json(200, { session: { ...SESSION, stateVersion: 2, viewed: { ...SESSION.viewed, ticket: true } } }));
    const s = await postSessionAction(SESSION.sessionId, 1, { type: "OPEN_TICKET", ticketId: "INC-104" });

    expect(sent().url).toBe(`https://api.example.com/v1/sessions/${SESSION.sessionId}/actions`);
    expect(sent().init.method).toBe("POST");
    expect(sent().body).toEqual({ expectedStateVersion: 1, action: { type: "OPEN_TICKET", ticketId: "INC-104" } });
    expect(s.stateVersion).toBe(2);
  });

  it("maps a version conflict to a typed 409 the UI can recover from", async () => {
    fetchMock.mockResolvedValue(json(409, { code: "VERSION_CONFLICT", message: "reload", requestId: "r" }));
    await expect(
      postSessionAction(SESSION.sessionId, 1, { type: "OPEN_TICKET", ticketId: "INC-104" }),
    ).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
  });

  it("rejects a session response that violates the contract (a diagnostics source that is not SYNTHETIC)", async () => {
    const bad = structuredClone(SESSION);
    (bad.scenario.diagnostics as { source: string }).source = "AWS_CLOUDWATCH";
    fetchMock.mockResolvedValue(json(200, { session: bad }));
    await expect(fetchSession(SESSION.sessionId)).rejects.toThrow();
  });

  it("drops the session on 401 for the new calls too", async () => {
    fetchMock.mockResolvedValue(json(401, { message: "Unauthorized" }));
    await expect(fetchSession(SESSION.sessionId)).rejects.toMatchObject({ status: 401 });
    expect(getSession()).toBeNull();
  });

  it("makes no request at all without a session", async () => {
    storage.clear();
    await expect(startAssignment(ASSIGNMENT.assignmentId)).rejects.toMatchObject({ status: 401, code: "NO_SESSION" });
    await expect(listAssignments("northstar-cloud")).rejects.toMatchObject({ code: "NO_SESSION" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const HASH_1800 = "sha256:" + "c".repeat(64);
const RUN = {
  testRunId: "run_0001_aaaaaaaaaaaa",
  status: "PASSED",
  configRevision: 1,
  configHash: HASH_1800,
  configSnapshot: { request_timeout_ms: 1800 },
  suiteVersion: 1,
  createdAt: "2026-11-07T10:01:00.000Z",
  completedAt: "2026-11-07T10:01:01.000Z",
  cases: [{ caseId: "schema-valid", name: "Configuration is well-formed", status: "PASS", message: "ok" }],
  passedCount: 1,
  totalCount: 1,
  executor: { kind: "AWS_LAMBDA", region: "us-east-1", runnerRequestId: "r-1", invokeRequestId: "i-1" },
  errorCode: null,
  errorMessage: null,
  current: true,
  stale: false,
};
const SESSION_WITH_RUN = {
  ...SESSION,
  stateVersion: 4,
  config: { request_timeout_ms: 1800 },
  configRevision: 1,
  configHash: HASH_1800,
  revisions: [{ revision: 1, config: { request_timeout_ms: 1800 }, configHash: HASH_1800, savedAt: "2026-11-07T10:00:30.000Z" }],
  testRuns: [RUN],
  currentEvidence: { status: "PASSED", testRunId: RUN.testRunId },
};

describe("configuration and test calls", () => {
  beforeEach(() => signIn(storage, "tok"));

  it("saveConfig PUTs exactly { expectedStateVersion, config } -- no revision, hash or result", async () => {
    fetchMock.mockResolvedValue(json(200, { session: SESSION_WITH_RUN }));
    const s = await saveConfig(SESSION.sessionId, 1, { request_timeout_ms: 1800 });
    expect(sent().url).toBe(`https://api.example.com/v1/sessions/${SESSION.sessionId}/config`);
    expect(sent().init.method).toBe("PUT");
    expect(sent().body).toEqual({ expectedStateVersion: 1, config: { request_timeout_ms: 1800 } });
    expect(s.configRevision).toBe(1);
  });

  it("requestTestRun POSTs only the expected version and returns the validated run and session", async () => {
    fetchMock.mockResolvedValue(json(201, { testRun: RUN, session: SESSION_WITH_RUN }));
    const r = await requestTestRun(SESSION.sessionId, 2);
    expect(sent().url).toBe(`https://api.example.com/v1/sessions/${SESSION.sessionId}/test-runs`);
    expect(sent().init.method).toBe("POST");
    expect(sent().body).toEqual({ expectedStateVersion: 2 });
    expect(r.testRun.executor?.kind).toBe("AWS_LAMBDA");
  });

  it("fetchTestRun GETs the run under the session and encodes the id", async () => {
    fetchMock.mockResolvedValue(json(200, { testRun: RUN, session: SESSION_WITH_RUN }));
    await fetchTestRun(SESSION.sessionId, RUN.testRunId);
    expect(sent().url).toBe(`https://api.example.com/v1/sessions/${SESSION.sessionId}/test-runs/${RUN.testRunId}`);
    expect(sent().init.method).toBe("GET");
    expect(sent().body).toBeUndefined();
    fetchMock.mockResolvedValue(json(200, { testRun: RUN, session: SESSION_WITH_RUN }));
    await fetchTestRun(SESSION.sessionId, "../x");
    expect(sent().url).toBe(`https://api.example.com/v1/sessions/${SESSION.sessionId}/test-runs/..%2Fx`); // separator encoded
    expect(sent().url).not.toContain("/../");
  });

  it("surfaces server validation and conflict codes", async () => {
    fetchMock.mockResolvedValue(json(422, { code: "CONFIG_OUT_OF_POLICY", message: "out of range", requestId: "r" }));
    await expect(saveConfig(SESSION.sessionId, 1, { request_timeout_ms: 5000 })).rejects.toMatchObject({ status: 422, code: "CONFIG_OUT_OF_POLICY" });
    fetchMock.mockResolvedValue(json(409, { code: "RUN_IN_PROGRESS", message: "busy", requestId: "r" }));
    await expect(requestTestRun(SESSION.sessionId, 2)).rejects.toMatchObject({ status: 409, code: "RUN_IN_PROGRESS" });
  });

  it("rejects a run response that claims PASSED but is not the contract shape", async () => {
    fetchMock.mockResolvedValue(json(201, { testRun: { ...RUN, executor: { kind: "SIMULATED" } }, session: SESSION_WITH_RUN }));
    await expect(requestTestRun(SESSION.sessionId, 2)).rejects.toThrow();
    fetchMock.mockResolvedValue(json(201, { testRun: { ...RUN, status: "SUCCESS" }, session: SESSION_WITH_RUN }));
    await expect(requestTestRun(SESSION.sessionId, 2)).rejects.toThrow();
  });
});

const SUB_ID = "sub_01_" + "d".repeat(32);
const FROZEN_RUN = (({ current: _c, stale: _s, ...rest }) => rest)(RUN);
const SUBMISSION = {
  submissionId: SUB_ID,
  attemptNumber: 1,
  sessionId: SESSION.sessionId,
  assignmentId: ASSIGNMENT.assignmentId,
  organizationId: "northstar-cloud",
  scenarioId: "inc-104",
  scenarioVersion: 1,
  rubricVersion: 1,
  manifestVersion: 1,
  submittedAt: "2026-11-07T10:05:00.000Z",
  report: {
    rootCause: "root cause text here", correctiveAction: "corrective text here", verification: "verification text here", remainingRisks: "risk text here too",
  },
  config: { revision: 1, configHash: HASH_1800, snapshot: { request_timeout_ms: 1800 } },
  testRun: FROZEN_RUN,
  investigation: { ticketOpened: true, runbookOpened: false, diagnosticsOpened: true },
  evidence: { eventSequence: 6 },
  evaluation: { status: "NOT_CONFIGURED", message: "No AI evaluation." },
  review: null,
};
const BUNDLE = {
  submission: SUBMISSION,
  employee: { userSub: "emp-1", displayName: "Employee" },
  assignment: { assignmentId: ASSIGNMENT.assignmentId, scenarioTitle: "INC-104", status: "AWAITING_REVIEW", attemptNumber: 1, latestSubmissionId: SUB_ID },
  history: [{ submissionId: SUB_ID, attemptNumber: 1, submittedAt: SUBMISSION.submittedAt, testStatus: "PASSED", configRevision: 1, review: null }],
  timeline: [{ sequence: 1, type: "INVESTIGATION_STARTED", occurredAt: "2026-11-07T10:00:00.000Z", actor: "EMPLOYEE", summary: "Started" }],
  canDecide: true,
};

describe("submission and review calls", () => {
  beforeEach(() => signIn(storage, "tok"));

  it("submitReport sends the Idempotency-Key header and a body of exactly the report plus the evidence assertion", async () => {
    fetchMock.mockResolvedValue(json(201, { submission: SUBMISSION, session: SESSION_WITH_RUN, created: true }));
    const input = {
      expectedStateVersion: 4, testRunId: RUN.testRunId, configRevision: 1, configHash: HASH_1800, report: SUBMISSION.report,
    };
    const r = await submitReport(SESSION.sessionId, input, "key-12345678");
    expect(sent().url).toBe(`https://api.example.com/v1/sessions/${SESSION.sessionId}/submissions`);
    expect(sent().init.method).toBe("POST");
    expect(sent().headers["Idempotency-Key"]).toBe("key-12345678");
    expect(sent().headers["Authorization"]).toBe("Bearer tok");
    expect(sent().body).toEqual(input);
    expect(r.created).toBe(true);
  });

  it("submitReport surfaces evidence and conflict errors as typed errors", async () => {
    fetchMock.mockResolvedValue(json(422, { code: "EVIDENCE_NOT_CURRENT", message: "run the tests", requestId: "r" }));
    await expect(
      submitReport(SESSION.sessionId, { expectedStateVersion: 1, testRunId: RUN.testRunId, configRevision: 0, configHash: HASH_1800, report: SUBMISSION.report }, "key-12345678"),
    ).rejects.toMatchObject({ status: 422, code: "EVIDENCE_NOT_CURRENT" });
  });

  it("fetchReview GETs the bundle and validates it", async () => {
    fetchMock.mockResolvedValue(json(200, { review: BUNDLE }));
    const b = await fetchReview(SUB_ID);
    expect(sent().url).toBe(`https://api.example.com/v1/reviews/${SUB_ID}`);
    expect(sent().init.method).toBe("GET");
    expect(b.submission.testRun.executor?.kind).toBe("AWS_LAMBDA");
  });

  it("a review bundle that lies about the evaluation or the executor is rejected by the contract", async () => {
    fetchMock.mockResolvedValue(json(200, { review: { ...BUNDLE, submission: { ...SUBMISSION, evaluation: { status: "AI_APPROVED", message: "x" } } } }));
    await expect(fetchReview(SUB_ID)).rejects.toThrow();
    fetchMock.mockResolvedValue(json(200, { review: { ...BUNDLE, submission: { ...SUBMISSION, testRun: { ...FROZEN_RUN, executor: { kind: "SIMULATED" } } } } }));
    await expect(fetchReview(SUB_ID)).rejects.toThrow();
  });

  it("postReviewDecision sends only the decision (and feedback when present) -- never a reviewer, status or id", async () => {
    fetchMock.mockResolvedValue(json(200, { review: BUNDLE }));
    await postReviewDecision(SUB_ID, "APPROVE", "   ");
    expect(sent().url).toBe(`https://api.example.com/v1/reviews/${SUB_ID}/decision`);
    expect(sent().init.method).toBe("POST");
    expect(sent().body).toEqual({ decision: "APPROVE" });
    fetchMock.mockResolvedValue(json(200, { review: BUNDLE }));
    await postReviewDecision(SUB_ID, "REQUEST_REVISION", "  Please test a higher timeout.  ");
    expect(sent().body).toEqual({ decision: "REQUEST_REVISION", feedback: "Please test a higher timeout." });
  });

  it("a decision on an already-decided submission is a typed 409", async () => {
    fetchMock.mockResolvedValue(json(409, { code: "ALREADY_DECIDED", message: "decided", requestId: "r" }));
    await expect(postReviewDecision(SUB_ID, "APPROVE", "")).rejects.toMatchObject({ status: 409, code: "ALREADY_DECIDED" });
  });
});

const TURN = {
  turnId: "turn_1794045600000_0123456789ab",
  status: "COMPLETE",
  userText: "What should I check first?",
  reply: "Compare the upstream latency in the logs with the configured timeout.",
  truncated: false,
  modelId: "amazon.nova-micro-v1:0",
  createdAt: "2026-11-07T10:00:00.000Z",
  completedAt: "2026-11-07T10:00:01.000Z",
  errorCode: null,
  errorMessage: null,
};
const COWORKER_STATE = {
  enabled: true, canSend: true, reason: null, modelId: "amazon.nova-micro-v1:0", completedTurns: 1, attemptsUsed: 1,
  limits: { maxMessageChars: 600, maxCompletedTurns: 20, maxAttempts: 30 },
};

describe("AI coworker calls", () => {
  beforeEach(() => signIn(storage, "tok"));

  it("fetchCoworker GETs the persisted conversation and validates it", async () => {
    fetchMock.mockResolvedValue(json(200, { turns: [TURN], coworker: COWORKER_STATE }));
    const r = await fetchCoworker(SESSION.sessionId);
    expect(sent().url).toBe(`https://api.example.com/v1/sessions/${SESSION.sessionId}/messages`);
    expect(sent().init.method).toBe("GET");
    expect(sent().body).toBeUndefined();
    expect(r.turns[0]?.reply).toMatch(/upstream latency/);
    expect(r.coworker.modelId).toBe("amazon.nova-micro-v1:0");
  });

  it("sendCoworkerMessage sends exactly { message } and the Idempotency-Key -- no model, role, prompt or status", async () => {
    fetchMock.mockResolvedValue(json(201, { turn: TURN, coworker: COWORKER_STATE, created: true }));
    const r = await sendCoworkerMessage(SESSION.sessionId, "What should I check first?", "key-abcdef123456");
    expect(sent().url).toBe(`https://api.example.com/v1/sessions/${SESSION.sessionId}/messages`);
    expect(sent().init.method).toBe("POST");
    expect(sent().body).toEqual({ message: "What should I check first?" });
    expect(sent().headers["Idempotency-Key"]).toBe("key-abcdef123456");
    expect(sent().headers["Authorization"]).toBe("Bearer tok");
    expect(r.created).toBe(true);
  });

  it("surfaces busy, closed, limit and unavailable responses as typed errors", async () => {
    for (const [status, code] of [[409, "COWORKER_BUSY"], [409, "SESSION_NOT_OPEN"], [429, "COWORKER_LIMIT_REACHED"], [503, "AI_UNAVAILABLE"]] as const) {
      fetchMock.mockResolvedValue(json(status, { code, message: "x", requestId: "r" }));
      await expect(sendCoworkerMessage(SESSION.sessionId, "hi", "key-abcdef123456")).rejects.toMatchObject({ status, code });
    }
  });

  it("rejects a turn that claims to be complete without a reply, or an unknown status, or an oversized reply", async () => {
    for (const bad of [{ ...TURN, status: "DONE" }, { ...TURN, reply: "x".repeat(2001) }, { ...TURN, turnId: "t1" }, { ...TURN, modelId: undefined }]) {
      fetchMock.mockResolvedValue(json(200, { turns: [bad], coworker: COWORKER_STATE }));
      await expect(fetchCoworker(SESSION.sessionId)).rejects.toThrow();
    }
  });

  it("does not leak provider detail even if the server sent it: extra keys are stripped by the contract", async () => {
    fetchMock.mockResolvedValue(json(200, { turns: [{ ...TURN, usageTokens: { input: 1 }, providerRequestId: "rid" }], coworker: COWORKER_STATE }));
    const r = await fetchCoworker(SESSION.sessionId);
    expect(JSON.stringify(r)).not.toMatch(/usageTokens|providerRequestId/);
  });

  it("makes no request without a session, and drops the session on 401", async () => {
    storage.clear();
    await expect(fetchCoworker(SESSION.sessionId)).rejects.toMatchObject({ code: "NO_SESSION" });
    expect(fetchMock).not.toHaveBeenCalled();
    signIn(storage, "tok");
    fetchMock.mockResolvedValue(json(401, { message: "Unauthorized" }));
    await expect(sendCoworkerMessage(SESSION.sessionId, "hi", "key-abcdef123456")).rejects.toMatchObject({ status: 401 });
    expect(getSession()).toBeNull();
  });
});
