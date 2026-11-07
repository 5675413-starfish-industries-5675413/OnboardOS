/**
 * API client for the OnboardOS backend.
 *
 * Every request attaches the Cognito ACCESS token as a Bearer token. The token
 * is read from sessionStorage via getSession(). This module never reads or
 * transmits AWS credentials, client secrets, or passwords.
 */

import type { MeResponse } from "@onboardos/contracts";
import { MeResponseSchema } from "@onboardos/contracts";
import { config } from "./config.js";
import { getSession, clearSession } from "./auth.js";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function apiFetch<T>(
  path: string,
  schema: { parse: (v: unknown) => T },
): Promise<T> {
  const session = getSession();
  if (!session) {
    throw new ApiError(401, "NO_SESSION", "Not signed in");
  }

  let response: Response;
  try {
    response = await fetch(`${config.apiBaseUrl}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        // The API Gateway JWT authorizer reads "Authorization: Bearer <token>".
        Authorization: `Bearer ${session.accessToken}`,
      },
    });
  } catch {
    // fetch rejects on network failure and on CORS rejection.
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the OnboardOS API.");
  }

  if (response.status === 401) {
    // Expired/invalid session: drop it so the app returns to the sign-in page.
    clearSession();
    throw new ApiError(401, "UNAUTHORIZED", "Your session has expired. Please sign in again.");
  }

  if (!response.ok) {
    let code = "UNKNOWN";
    let message = `Request failed (HTTP ${response.status}).`;
    try {
      const body = (await response.json()) as { code?: unknown; message?: unknown };
      if (typeof body.code === "string") code = body.code;
      if (typeof body.message === "string") message = body.message;
    } catch {
      // non-JSON error body: keep defaults
    }
    throw new ApiError(response.status, code, message);
  }

  // Validate the response against the shared contract before using it.
  return schema.parse(await response.json());
}

/** GET /v1/me -- the authenticated user's identity and ACTIVE memberships. */
export async function getMe(): Promise<MeResponse> {
  return apiFetch("/v1/me", MeResponseSchema);
}
