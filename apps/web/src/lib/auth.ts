/**
 * Browser-side authentication helpers.
 *
 * Implements the OAuth 2.0 authorization-code + PKCE flow against the Cognito
 * Hosted UI, and holds the resulting ACCESS token in sessionStorage (cleared
 * when the tab closes).
 *
 * Security properties:
 *  - The PKCE verifier and `state` are single-use: they are removed from
 *    storage BEFORE the token request is sent, so a replayed or duplicated
 *    callback can never reuse them.
 *  - Concurrent/duplicate calls for the same authorization code (React
 *    StrictMode runs effects twice in development) share ONE token exchange.
 *    Authorization codes are single-use; a second exchange would be rejected.
 *  - Only the access token is stored. No refresh flow is implemented, so no
 *    refresh token is persisted (a 30-day credential in script-readable storage
 *    with no consumer is risk without benefit). The ID token is never stored.
 *  - Tokens are never logged.
 */

import {
  config,
  buildLoginUrl,
  buildLogoutUrl,
  localSignInOriginWarning,
  redirectUri,
  tokenEndpoint,
} from "./config.js";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from "./pkce.js";

const STORAGE_KEYS = {
  accessToken: "onboardos.access_token",
  tokenExpiry: "onboardos.token_expiry",
  codeVerifier: "onboardos.pkce_verifier",
  oauthState: "onboardos.oauth_state",
} as const;

// Keys written by earlier builds. Always cleaned up on sign-out/expiry.
const LEGACY_KEYS = ["onboardos.refresh_token"] as const;

export interface SessionTokens {
  accessToken: string;
  expiresAt: number; // epoch ms
}

/** The current session, or null if absent/expired (expired sessions are cleared). */
export function getSession(): SessionTokens | null {
  const accessToken = sessionStorage.getItem(STORAGE_KEYS.accessToken);
  const expiryStr = sessionStorage.getItem(STORAGE_KEYS.tokenExpiry);
  if (!accessToken || !expiryStr) return null;
  const expiresAt = parseInt(expiryStr, 10);
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    clearSession();
    return null;
  }
  return { accessToken, expiresAt };
}

/** Persist the access token from a successful token exchange. */
function saveSession(accessToken: string, expiresInSeconds: number): void {
  // 30s safety buffer so we never send a token that expires in flight.
  const expiresAt = Date.now() + expiresInSeconds * 1000 - 30_000;
  sessionStorage.setItem(STORAGE_KEYS.accessToken, accessToken);
  sessionStorage.setItem(STORAGE_KEYS.tokenExpiry, String(expiresAt));
}

/** Clear all session and in-flight login state. */
export function clearSession(): void {
  for (const key of [...Object.values(STORAGE_KEYS), ...LEGACY_KEYS]) {
    sessionStorage.removeItem(key);
  }
}

/** Start the authorization-code + PKCE login: store verifier/state, then redirect. */
export async function initiateLogin(): Promise<void> {
  const originProblem = localSignInOriginWarning();
  if (originProblem) throw new Error(originProblem);

  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = generateState();

  sessionStorage.setItem(STORAGE_KEYS.codeVerifier, verifier);
  sessionStorage.setItem(STORAGE_KEYS.oauthState, state);

  window.location.href = buildLoginUrl(challenge, state);
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

function isTokenResponse(v: unknown): v is TokenResponse {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["access_token"] === "string" &&
    r["access_token"].length > 0 &&
    typeof r["expires_in"] === "number" &&
    r["expires_in"] > 0
  );
}

async function exchangeCode(code: string, returnedState: string): Promise<void> {
  const storedState = sessionStorage.getItem(STORAGE_KEYS.oauthState);
  const verifier = sessionStorage.getItem(STORAGE_KEYS.codeVerifier);

  // Consume both values NOW, before any network I/O. Whatever happens next
  // (success, rejection, thrown error) they cannot be used a second time.
  sessionStorage.removeItem(STORAGE_KEYS.oauthState);
  sessionStorage.removeItem(STORAGE_KEYS.codeVerifier);

  if (!storedState || !verifier) {
    throw new Error(
      "This sign-in attempt has expired or was already used. Please sign in again.",
    );
  }
  if (returnedState !== storedState) {
    throw new Error("Sign-in could not be verified (state mismatch). Please sign in again.");
  }

  let response: Response;
  try {
    response = await fetch(tokenEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.cognito.clientId,
        code,
        redirect_uri: redirectUri(),
        code_verifier: verifier,
      }).toString(),
    });
  } catch {
    throw new Error("Could not reach the sign-in service. Check your connection and try again.");
  }

  if (!response.ok) {
    // Surface only the OAuth error code (e.g. "invalid_grant"), never the raw body.
    let oauthError = "unknown_error";
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error)) {
        oauthError = body.error;
      }
    } catch {
      // non-JSON error body: keep the generic code
    }
    throw new Error(`Sign-in was rejected (${oauthError}). Please sign in again.`);
  }

  const tokens: unknown = await response.json();
  if (!isTokenResponse(tokens)) {
    throw new Error("Sign-in returned an unexpected response. Please sign in again.");
  }
  saveSession(tokens.access_token, tokens.expires_in);
}

// Remember the most recent exchange so duplicate invocations for the SAME code
// (StrictMode double effects, double-clicks) share one request and one outcome.
let lastExchange: { code: string; promise: Promise<void> } | null = null;

/**
 * Complete the callback: verify `state`, exchange the code (once) for tokens.
 * Safe to call more than once with the same code.
 */
export function handleCallback(code: string, returnedState: string): Promise<void> {
  if (lastExchange && lastExchange.code === code) {
    return lastExchange.promise;
  }
  const promise = exchangeCode(code, returnedState);
  lastExchange = { code, promise };
  return promise;
}

/** Sign out: clear local state, then end the Cognito Hosted UI session. */
export function logout(): void {
  clearSession();
  window.location.href = buildLogoutUrl();
}
