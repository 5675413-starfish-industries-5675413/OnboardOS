/**
 * PKCE (Proof Key for Code Exchange) helpers for the authorization-code flow.
 *
 * Uses the Web Crypto API (available in all modern browsers).
 * No external library required.
 */

/** Generate a cryptographically random code verifier (43–128 chars, URL-safe). */
export function generateCodeVerifier(): string {
  const array = new Uint8Array(48);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/** Compute the SHA-256 code challenge from a verifier. */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

/** Generate a random state parameter to prevent CSRF. */
export function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const byte of bytes) {
    str += String.fromCharCode(byte);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
