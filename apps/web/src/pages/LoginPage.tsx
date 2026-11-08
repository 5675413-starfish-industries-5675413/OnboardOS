import { useState } from "react";
import { useLocation } from "react-router-dom";
import { initiateLogin } from "../lib/auth.js";
import { missingConfig } from "../lib/config.js";

const STEPS = [
  "A manager assigns the INC-104 simulation.",
  "You investigate the ticket, runbook, and synthetic diagnostics.",
  "AWS runs deterministic checks on the revision you save.",
  "Your manager reviews the frozen evidence.",
];

export function LoginPage() {
  const location = useLocation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const missing = missingConfig();
  const expired = (location.state as { reason?: string } | null)?.reason === "expired";

  async function handleLogin() {
    setLoading(true);
    setError(null);
    try {
      await initiateLogin();
      // initiateLogin() navigates the browser away; nothing runs after this.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="card login-card">
        <p className="eyebrow">Northstar Cloud</p>
        <h1>Sign in to OnboardOS</h1>
        <p>
          Learn the job by doing the job. Sign in with your Northstar Cloud
          account to access your onboarding workspace.
        </p>
        {expired && (
          <div className="info" role="status">
            Your session has expired. Please sign in again.
          </div>
        )}
        {missing.length > 0 && (
          <div className="error" role="alert">
            This build is missing required configuration: {missing.join(", ")}.
            Set it in <code>apps/web/.env.local</code> and restart the dev
            server (see <code>apps/web/.env.example</code>).
          </div>
        )}
        {error && <div className="error" role="alert">{error}</div>}
        <button
          className="btn"
          onClick={handleLogin}
          disabled={loading || missing.length > 0}
        >
          {loading ? "Redirecting…" : "Sign in with Northstar Cloud"}
        </button>
        <p className="muted">
          Accounts are provisioned by your organization administrator. This page redirects to the organization sign-in service. It does not collect a password here.
        </p>
        <ol className="login-steps">
          {STEPS.map((step, index) => <li key={step}><span>{index + 1}</span>{step}</li>)}
        </ol>
      </div>
    </div>
  );
}
