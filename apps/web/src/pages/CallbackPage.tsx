import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { handleCallback } from "../lib/auth.js";

/**
 * Cognito authorization-code + PKCE callback: /callback?code=...&state=...
 * (or ?error=...&error_description=... if the user/Cognito rejected the login).
 */
export function CallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // React StrictMode (development) runs effects twice. The ref makes the
  // callback run exactly once per mounted page; auth.ts additionally shares a
  // single token exchange per authorization code.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const oauthError = params.get("error");

    // Remove the one-time code/state from the address bar and history now.
    window.history.replaceState({}, "", "/callback");

    if (oauthError) {
      // Do not echo error_description (attacker-controllable text).
      setError(
        oauthError === "access_denied"
          ? "Sign-in was cancelled or denied."
          : "The sign-in service reported an error. Please try again.",
      );
      return;
    }
    if (!code || !state) {
      setError("Invalid sign-in callback: missing authorization code or state.");
      return;
    }

    handleCallback(code, state)
      .then(() => navigate("/app", { replace: true }))
      .catch((err: unknown) => {
        setError(
          err instanceof Error
            ? err.message
            : "Authentication failed. Please try signing in again.",
        );
      });
  }, [navigate]);

  if (error) {
    return (
      <div className="login-screen"><div className="container">
        <div className="card">
          <h1>Authentication Error</h1>
          <div className="error" role="alert">{error}</div>
          <a href="/" className="btn btn-sm">
            Back to sign-in
          </a>
        </div>
      </div></div>
    );
  }

  return (
    <div className="login-screen"><div className="container">
      <div className="card">
        <p role="status">Completing sign-in…</p>
      </div>
    </div></div>
  );
}
