import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clearSession,
  getSession,
  handleCallback,
  initiateLogin,
  logout,
} from "../lib/auth.js";
import { generateCodeChallenge } from "../lib/pkce.js";
import {
  CLIENT_ID,
  HOST,
  KEYS,
  ORIGIN,
  setupBrowserEnv,
  type FakeLocation,
  type FakeStorage,
} from "./helpers.js";

let storage: FakeStorage;
let location: FakeLocation;
const fetchMock = vi.fn();

const TOKEN_BODY = {
  access_token: "ACCESS-TOKEN-VALUE",
  id_token: "ID-TOKEN-VALUE",
  refresh_token: "REFRESH-TOKEN-VALUE",
  token_type: "Bearer",
  expires_in: 3600,
};

function ok(body: unknown = TOKEN_BODY): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Run the first half of the flow and return what was stored for the callback. */
async function startLogin(): Promise<{ state: string; verifier: string }> {
  await initiateLogin();
  return {
    state: storage.getItem(KEYS.oauthState) ?? "",
    verifier: storage.getItem(KEYS.codeVerifier) ?? "",
  };
}

beforeEach(() => {
  ({ storage, location } = setupBrowserEnv());
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ok());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("initiateLogin (authorization request)", () => {
  it("stores a one-time verifier and state, and redirects with the matching S256 challenge", async () => {
    const { state, verifier } = await startLogin();

    expect(verifier.length).toBeGreaterThanOrEqual(43); // RFC 7636 minimum
    expect(state.length).toBeGreaterThan(8);

    const url = new URL(location.href);
    expect(`${url.origin}${url.pathname}`).toBe(`https://${HOST}/oauth2/authorize`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(await generateCodeChallenge(verifier));
    expect(url.searchParams.get("state")).toBe(state);
    // Public client: there must never be a secret on the wire.
    expect(url.searchParams.has("client_secret")).toBe(false);
    // The verifier itself must never be sent in the authorization request.
    expect(location.href).not.toContain(verifier);
  });

  it("does not redirect when the page is opened through 127.0.0.1", async () => {
    location.origin = "http://127.0.0.1:5173";
    location.href = "http://127.0.0.1:5173/";
    await expect(initiateLogin()).rejects.toThrow(/localhost:5173/);
    expect(location.href).toBe("http://127.0.0.1:5173/");
    expect(storage.getItem(KEYS.oauthState)).toBeNull();
  });
});

describe("handleCallback (token exchange)", () => {
  it("exchanges the code with the stored verifier and saves ONLY the access token", async () => {
    const { state, verifier } = await startLogin();
    await handleCallback("code-ok", state);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://${HOST}/oauth2/token`);
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("code")).toBe("code-ok");
    expect(body.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(body.get("code_verifier")).toBe(verifier);
    expect(body.has("client_secret")).toBe(false);

    expect(getSession()?.accessToken).toBe("ACCESS-TOKEN-VALUE");
    // Neither the refresh token nor the ID token is persisted anywhere.
    const stored = storage.entries();
    expect(stored.some(([k]) => /refresh|id_token/i.test(k))).toBe(false);
    expect(stored.some(([, v]) => v.includes("REFRESH-TOKEN-VALUE") || v.includes("ID-TOKEN-VALUE"))).toBe(false);
  });

  it("consumes the verifier and state after a successful exchange", async () => {
    const { state } = await startLogin();
    await handleCallback("code-consume", state);
    expect(storage.getItem(KEYS.codeVerifier)).toBeNull();
    expect(storage.getItem(KEYS.oauthState)).toBeNull();
  });

  it("StrictMode regression: duplicate calls for one code share ONE exchange and both succeed", async () => {
    const { state } = await startLogin();
    // React StrictMode runs the callback effect twice, synchronously.
    const first = handleCallback("code-dup", state);
    const second = handleCallback("code-dup", state);

    await expect(Promise.all([first, second])).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1); // codes are single-use
    expect(getSession()?.accessToken).toBe("ACCESS-TOKEN-VALUE");
  });

  it("rejects a replayed callback: a second, different code cannot reuse the spent verifier", async () => {
    const { state } = await startLogin();
    await handleCallback("code-first", state);

    await expect(handleCallback("code-replay", state)).rejects.toThrow(/expired or was already used/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a state mismatch (CSRF) without calling the token endpoint, and burns the verifier", async () => {
    await startLogin();
    await expect(handleCallback("code-csrf", "attacker-state")).rejects.toThrow(/state mismatch/);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getSession()).toBeNull();
    expect(storage.getItem(KEYS.codeVerifier)).toBeNull();
    expect(storage.getItem(KEYS.oauthState)).toBeNull();
  });

  it("rejects a callback with no login in progress (missing verifier/state)", async () => {
    await expect(handleCallback("code-orphan", "whatever")).rejects.toThrow(/expired or was already used/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces only the OAuth error code on rejection, never the response body", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "<script>alert(1)</script>" }),
          { status: 400 },
        ),
    );
    const { state } = await startLogin();
    const err = await handleCallback("code-bad", state).catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("invalid_grant");
    expect((err as Error).message).not.toContain("<script>");
    expect(getSession()).toBeNull();
    // Failed exchange must also clean up PKCE state so the user restarts cleanly.
    expect(storage.getItem(KEYS.codeVerifier)).toBeNull();
    expect(storage.getItem(KEYS.oauthState)).toBeNull();
  });

  it("falls back to a generic code when the error body is not JSON", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>502</html>", { status: 502 }));
    const { state } = await startLogin();
    await expect(handleCallback("code-502", state)).rejects.toThrow(/unknown_error/);
  });

  it("reports a network failure clearly and still consumes PKCE state", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { state } = await startLogin();
    await expect(handleCallback("code-net", state)).rejects.toThrow(/Could not reach/);
    expect(storage.getItem(KEYS.codeVerifier)).toBeNull();
    expect(getSession()).toBeNull();
  });

  it("rejects a malformed token response and stores nothing", async () => {
    fetchMock.mockImplementation(async () => ok({ access_token: "", expires_in: "soon" }));
    const { state } = await startLogin();
    await expect(handleCallback("code-malformed", state)).rejects.toThrow(/unexpected response/);
    expect(getSession()).toBeNull();
    expect(storage.entries().some(([k]) => k === KEYS.accessToken)).toBe(false);
  });
});

describe("session lifetime", () => {
  it("treats an expired session as signed out and clears it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { state } = await startLogin();
    await handleCallback("code-expiry", state);
    expect(getSession()).not.toBeNull();

    vi.setSystemTime(Date.now() + 3600 * 1000); // past expires_in
    expect(getSession()).toBeNull();
    expect(storage.getItem(KEYS.accessToken)).toBeNull();
  });

  it("clearSession removes access token, in-flight PKCE state, and the legacy refresh-token key", () => {
    storage.setItem(KEYS.accessToken, "a");
    storage.setItem(KEYS.tokenExpiry, "1");
    storage.setItem(KEYS.codeVerifier, "v");
    storage.setItem(KEYS.oauthState, "s");
    storage.setItem("onboardos.refresh_token", "legacy");
    clearSession();
    expect(storage.entries()).toHaveLength(0);
  });

  it("logout clears the session and redirects to the Cognito logout endpoint", () => {
    storage.setItem(KEYS.accessToken, "a");
    storage.setItem(KEYS.tokenExpiry, String(Date.now() + 60_000));
    logout();

    expect(getSession()).toBeNull();
    const url = new URL(location.href);
    expect(`${url.origin}${url.pathname}`).toBe(`https://${HOST}/logout`);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("logout_uri")).toBe(ORIGIN);
  });
});
