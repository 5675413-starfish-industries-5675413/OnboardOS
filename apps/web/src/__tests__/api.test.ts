import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ApiError,
  createAssignment,
  fetchSession,
  getMe,
  listAssignableEmployees,
  listAssignments,
  postSessionAction,
  startAssignment,
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
