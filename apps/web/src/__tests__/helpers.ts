import { vi } from "vitest";

/** Minimal in-memory Storage so auth code runs under Vitest's node environment. */
export class FakeStorage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
  entries(): Array<[string, string]> {
    return [...this.data.entries()];
  }
}

export const ORIGIN = "http://localhost:5173";
export const HOST = "test-abc12345.auth.us-east-1.amazoncognito.com";
export const CLIENT_ID = "client-123";

export const KEYS = {
  accessToken: "onboardos.access_token",
  tokenExpiry: "onboardos.token_expiry",
  codeVerifier: "onboardos.pkce_verifier",
  oauthState: "onboardos.oauth_state",
} as const;

export interface FakeLocation {
  origin: string;
  href: string;
  search: string;
}

/** Stub the browser globals and public VITE_* config. Pair with vi.unstubAll*. */
export function setupBrowserEnv(): { storage: FakeStorage; location: FakeLocation } {
  const storage = new FakeStorage();
  const location: FakeLocation = { origin: ORIGIN, href: `${ORIGIN}/`, search: "" };
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("window", { location });
  vi.stubEnv("VITE_COGNITO_DOMAIN", HOST);
  vi.stubEnv("VITE_COGNITO_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com/");
  vi.stubEnv("VITE_AWS_REGION", "us-east-1");
  return { storage, location };
}

/** Put a valid (unexpired) access-token session into storage. */
export function signIn(storage: FakeStorage, token = "access-token-abc"): void {
  storage.setItem(KEYS.accessToken, token);
  storage.setItem(KEYS.tokenExpiry, String(Date.now() + 10 * 60 * 1000));
}
