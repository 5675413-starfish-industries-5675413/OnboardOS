/**
 * Public frontend configuration.
 *
 * All values come from Vite environment variables (VITE_* prefix) and are
 * embedded in the browser bundle -- NEVER put secrets, passwords, AWS access
 * keys, or client secrets here.
 *
 * WHERE VITE READS THEM: Vite loads .env files from the app root, i.e.
 * `apps/web/` -- NOT the repository root, and not the directory npm was
 * invoked from. Put the values in `apps/web/.env.local` (gitignored).
 * See `apps/web/.env.example`.
 */

/// <reference types="vite/client" />

function env(key: string): string {
  const val = (import.meta.env as Record<string, string | undefined>)[key];
  return (val ?? "").trim();
}

// Getters (not constants) so values are read at call time. This keeps the
// module testable with vi.stubEnv and has no effect on the production bundle,
// where Vite inlines import.meta.env at build time.
export const config = {
  get apiBaseUrl(): string {
    // Tolerate a trailing slash so `${apiBaseUrl}/v1/me` never contains "//".
    return env("VITE_API_BASE_URL").replace(/\/+$/, "");
  },
  /**
   * Feature flag for the AI coworker panel. OFF unless set to exactly "true" (any case).
   *
   * The frontend deploys from Git on merge; the API routes it calls deploy separately with SAM. Without a flag,
   * a merge made before the backend is ready would show a panel whose requests fail. Turn this on only after the
   * stack has been updated AND the stack parameter CoworkerModelId is set. It is read at build time, so changing
   * it needs a redeploy of the frontend. It is a convenience, not a control: the API enforces everything itself.
   */
  get coworkerEnabled(): boolean {
    return env("VITE_COWORKER_ENABLED").toLowerCase() === "true";
  },
  cognito: {
    get userPoolId(): string {
      return env("VITE_COGNITO_USER_POOL_ID");
    },
    get clientId(): string {
      return env("VITE_COGNITO_CLIENT_ID");
    },
    get region(): string {
      return env("VITE_AWS_REGION") || "us-east-1";
    },
    // Full Hosted UI host (CloudFormation output CognitoHostedUiDomain), e.g.
    // "<prefix>.auth.us-east-1.amazoncognito.com". A bare prefix is also accepted.
    get hostedUiDomain(): string {
      return env("VITE_COGNITO_DOMAIN");
    },
  },
};

/** Names of required VITE_* variables that are unset. Empty means configured. */
export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!config.apiBaseUrl) missing.push("VITE_API_BASE_URL");
  if (!config.cognito.clientId) missing.push("VITE_COGNITO_CLIENT_ID");
  if (!config.cognito.hostedUiDomain) missing.push("VITE_COGNITO_DOMAIN");
  return missing;
}

/** Resolve the Hosted UI host from either a full host or a bare prefix. */
export function hostedUiHost(): string {
  const { hostedUiDomain, region } = config.cognito;
  return hostedUiDomain.includes(".")
    ? hostedUiDomain
    : `${hostedUiDomain}.auth.${region}.amazoncognito.com`;
}

/** The redirect URI registered on the app client (CallbackURLs). */
export function redirectUri(origin: string = window.location.origin): string {
  return `${origin}/callback`;
}

/** Build the Hosted UI authorize URL for the authorization-code + PKCE flow. */
export function buildLoginUrl(
  codeChallenge: string,
  state: string,
  origin: string = window.location.origin,
): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: config.cognito.clientId,
    redirect_uri: redirectUri(origin),
    scope: "openid email profile",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `https://${hostedUiHost()}/oauth2/authorize?${query.toString()}`;
}

/** Build the Cognito token endpoint URL. */
export function tokenEndpoint(): string {
  return `https://${hostedUiHost()}/oauth2/token`;
}

/** Build the Cognito logout URL (logout_uri must match a registered LogoutURL). */
export function buildLogoutUrl(origin: string = window.location.origin): string {
  const query = new URLSearchParams({
    client_id: config.cognito.clientId,
    logout_uri: origin,
  });
  return `https://${hostedUiHost()}/logout?${query.toString()}`;
}
