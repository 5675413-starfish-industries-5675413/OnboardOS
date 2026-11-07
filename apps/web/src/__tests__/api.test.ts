import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ApiError, getMe } from "../lib/api.js";
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
