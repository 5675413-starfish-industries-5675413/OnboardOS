import { describe, expect, it } from "vitest";
import type { AssignmentView, SessionView } from "@onboardos/contracts";
import { ApiError } from "../lib/api.js";
import {
  actionForTab,
  canRunTests,
  describeApiError,
  hasAssignment,
  mergeAssignment,
  parseTimeoutInput,
  runBadge,
  shortHash,
  viewForRole,
} from "../lib/views.js";

const session = (viewed: Partial<SessionView["viewed"]> = {}): SessionView =>
  ({
    viewed: { ticket: false, runbook: false, diagnostics: false, ...viewed },
    scenario: {
      ticket: { id: "INC-104" },
      runbook: { id: "RB-CHECKOUT-TIMEOUT" },
      diagnostics: { id: "DIAG-INC-104" },
    },
  }) as unknown as SessionView;

const asg = (id: string, createdAt: string, sub?: string): AssignmentView => ({
  assignmentId: id, organizationId: "o", scenarioId: "inc-104", scenarioVersion: 1, scenarioTitle: "t",
  status: "ASSIGNED", sessionId: null, createdAt, startedAt: null,
  ...(sub ? { employee: { userSub: sub, displayName: "x" } } : {}),
});

describe("viewForRole", () => {
  it("shows the manager screen to managers, the employee screen to employees, and keeps admins on the identity screen", () => {
    expect(viewForRole("manager")).toBe("manager");
    expect(viewForRole("employee")).toBe("employee");
    expect(viewForRole("org_admin")).toBe("identity");
  });
});

describe("actionForTab", () => {
  it("builds each action from the server-supplied scenario ids", () => {
    expect(actionForTab(session(), "ticket")).toEqual({ type: "OPEN_TICKET", ticketId: "INC-104" });
    expect(actionForTab(session(), "runbook")).toEqual({ type: "OPEN_RUNBOOK", runbookId: "RB-CHECKOUT-TIMEOUT" });
    expect(actionForTab(session(), "diagnostics")).toEqual({ type: "OPEN_DIAGNOSTICS", diagnosticsId: "DIAG-INC-104" });
  });

  it("records nothing for an item that was already opened (no duplicate evidence after refresh)", () => {
    expect(actionForTab(session({ ticket: true }), "ticket")).toBeNull();
    expect(actionForTab(session({ ticket: true }), "runbook")).not.toBeNull();
  });
});

describe("assignment list helpers", () => {
  it("hasAssignment recognises an employee who already has one", () => {
    expect(hasAssignment([asg("a", "2026-01-01T00:00:00Z", "emp-1")], "emp-1")).toBe(true);
    expect(hasAssignment([asg("a", "2026-01-01T00:00:00Z", "emp-1")], "emp-2")).toBe(false);
    expect(hasAssignment([], "emp-1")).toBe(false);
  });

  it("mergeAssignment adds the server's assignment, de-duplicates by id, newest first", () => {
    const older = asg("a", "2026-01-01T00:00:00Z");
    const newer = asg("b", "2026-01-02T00:00:00Z");
    expect(mergeAssignment([older], newer).map((a) => a.assignmentId)).toEqual(["b", "a"]);

    const updated = { ...older, status: "IN_PROGRESS" as const };
    const merged = mergeAssignment([older, newer], updated);
    expect(merged).toHaveLength(2);
    expect(merged.find((a) => a.assignmentId === "a")?.status).toBe("IN_PROGRESS");
  });

  it("mergeAssignment does not mutate its input", () => {
    const list = Object.freeze([asg("a", "2026-01-01T00:00:00Z")]);
    expect(() => mergeAssignment(list, asg("b", "2026-01-02T00:00:00Z"))).not.toThrow();
    expect(list).toHaveLength(1);
  });
});

describe("describeApiError", () => {
  it.each([
    [0, "NETWORK_ERROR", /could not reach/i],
    [401, "UNAUTHORIZED", /expired/i],
    [403, "FORBIDDEN", /permission/i],
    [404, "NOT_FOUND", /not found/i],
    [409, "VERSION_CONFLICT", /changed.*reloaded/i],
    [409, "CONFLICT", /refresh/i],
    [429, "LIMIT_REACHED", /limit/i],
    [500, "INTERNAL_ERROR", /try again/i],
  ])("maps HTTP %i (%s) to friendly wording", (status, code, pattern) => {
    expect(describeApiError(new ApiError(status, code, "server said something internal: arn:aws:..."))).toMatch(pattern);
  });

  it("never echoes raw server text for non-422 errors", () => {
    expect(describeApiError(new ApiError(500, "X", "arn:aws:dynamodb:...secret"))).not.toContain("arn:");
  });

  it("passes through the message for a 422 (a deliberate, user-safe rule explanation)", () => {
    expect(describeApiError(new ApiError(422, "INVALID_TRANSITION", "Start the investigation first"))).toBe("Start the investigation first");
  });

  it("handles non-ApiError values", () => {
    expect(describeApiError(new Error("boom"))).toMatch(/something went wrong/i);
    expect(describeApiError("x")).toMatch(/something went wrong/i);
  });
});

describe("parseTimeoutInput (UX hint only; the server re-validates)", () => {
  it("accepts whole numbers on and inside the policy bounds", () => {
    expect(parseTimeoutInput("100")).toEqual({ ok: true, value: 100 });
    expect(parseTimeoutInput(" 1800 ")).toEqual({ ok: true, value: 1800 });
    expect(parseTimeoutInput("2000")).toEqual({ ok: true, value: 2000 });
  });
  it.each(["99", "2001", "0", "-5", "", "abc", "12.5", "1e3", "1800ms", "NaN", "99999999999999999999"])("rejects %j", (raw) => {
    expect(parseTimeoutInput(raw).ok).toBe(false);
  });
});

describe("run presentation", () => {
  it("never labels an error or failure as a pass", () => {
    expect(runBadge({ status: "PASSED", stale: false })).toEqual({ label: "Passed", tone: "ok" });
    expect(runBadge({ status: "FAILED", stale: false }).tone).toBe("bad");
    expect(runBadge({ status: "ERROR", stale: false }).tone).toBe("bad");
    expect(runBadge({ status: "PENDING", stale: false }).label).toBe("Running");
  });
  it("shortHash drops the algorithm prefix", () => {
    expect(shortHash("sha256:" + "ab".repeat(32))).toBe("abababababab");
  });
  it("canRunTests is false while busy, not investigating, or a run is active", () => {
    const s = { phase: "INVESTIGATING", activeTestRunId: null } as const;
    expect(canRunTests(s, false)).toBe(true);
    expect(canRunTests(s, true)).toBe(false);
    expect(canRunTests({ ...s, activeTestRunId: "run_0001_aaaaaaaaaaaa" }, false)).toBe(false);
    expect(canRunTests({ phase: "NOT_STARTED", activeTestRunId: null }, false)).toBe(false);
  });
  it("explains the new conflict and limit codes", () => {
    expect(describeApiError(new ApiError(409, "RUN_IN_PROGRESS", "x"))).toMatch(/already in progress/);
    expect(describeApiError(new ApiError(429, "RUN_LIMIT_REACHED", "x"))).toMatch(/test runs/);
    expect(describeApiError(new ApiError(429, "REVISION_LIMIT_REACHED", "x"))).toMatch(/revisions/);
    expect(describeApiError(new ApiError(422, "CONFIG_OUT_OF_POLICY", "Between 100 and 2000"))).toBe("Between 100 and 2000");
  });
});
