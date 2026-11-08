import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { MeResponse, OrgRole } from "@onboardos/contracts";
import { ApiError, getMe } from "../lib/api.js";
import { getSession, logout } from "../lib/auth.js";
import { viewForRole } from "../lib/views.js";
import { WorkspaceShell } from "../components/WorkspaceShell.js";
import { EmployeeView } from "../views/EmployeeView.js";
import { ManagerView } from "../views/ManagerView.js";
import { ScenariosSection } from "../views/ScenariosCard.js";
import { config } from "../lib/config.js";

function roleBadgeClass(role: OrgRole): string {
  switch (role) {
    case "org_admin": return "badge badge-admin";
    case "manager":   return "badge badge-manager";
    case "employee":  return "badge badge-employee";
  }
}

function roleLabel(role: OrgRole): string {
  switch (role) {
    case "org_admin": return "Admin";
    case "manager":   return "Manager";
    case "employee":  return "Employee";
  }
}

/**
 * Authenticated application shell — Phase 2A.
 *
 * Demonstrates the complete browser → Cognito → API Gateway → Lambda → DynamoDB
 * flow. Calls GET /v1/me and displays the verified organization and role.
 *
 * Phase 2A scope only: identity + memberships. The full workspace UI
 * (incident, config editor, test runner) is implemented in Phase 3.
 */
export function AppPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getSession()) {
      navigate("/", { replace: true, state: { reason: "expired" } });
      return;
    }

    // Guard against state updates after unmount (StrictMode double effect).
    let active = true;

    getMe()
      .then((data) => {
        if (!active) return;
        setMe(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) {
          navigate("/", { replace: true, state: { reason: "expired" } });
          return;
        }
        setError(
          err instanceof Error ? err.message : "Failed to load account information.",
        );
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [navigate]);

  if (loading) {
    return (
      <WorkspaceShell area="Overview">
        <div className="card"><p role="status">Loading your account…</p></div>
      </WorkspaceShell>
    );
  }

  if (error) {
    return (
      <WorkspaceShell area="Overview">
        <div className="card">
          <h1>Error</h1>
          <div className="error">{error}</div>
          <button className="btn btn-sm" onClick={logout}>Sign out</button>
        </div>
      </WorkspaceShell>
    );
  }

  if (!me) return null;

  // The server's answer picks the screen; it grants nothing. Every request a screen
  // makes is re-authorized by the backend from the verified token and DynamoDB.
  const primary = me.memberships[0];
  const view = primary ? viewForRole(primary.role) : "identity";

  return (
    <WorkspaceShell area="Overview" organization={primary?.organizationName} username={me.username}>
    <div className={view === "identity" ? "container" : "container-wide"}>
      <div className="card">
        <div className="row">
          <h1>OnboardOS</h1>
          <button className="btn btn-sm" onClick={logout}>Sign out</button>
        </div>

        <div className="info">
          Signed in as <strong>{me.username}</strong>
        </div>

        {me.memberships.length === 0 ? (
          <div className="error">
            Your account has no active organization membership. Contact your
            administrator to be added to an organization.
          </div>
        ) : (
          me.memberships.map((m) => (
            <div key={m.organizationId} style={{ marginBottom: "1.5rem" }}>
              <div className="row">
                <span className="value">{m.organizationName}</span>
                <span className={roleBadgeClass(m.role)}>
                  {roleLabel(m.role)}
                </span>
              </div>
              <div className="label" style={{ marginTop: ".25rem" }}>
                Organization ID: {m.organizationId}
              </div>
              {m.teamIds.length > 0 && (
                <div className="label" style={{ marginTop: ".25rem" }}>
                  Teams: {m.teamIds.join(", ")}
                </div>
              )}
            </div>
          ))
        )}

        <p style={{ fontSize: ".8rem", color: "#94a3b8", marginTop: "1rem" }}>
          Your role is determined by the server and cannot be changed from this page.
        </p>
      </div>

      {primary && view === "manager" && <ManagerView orgId={primary.organizationId} />}
      {primary && view === "employee" && <EmployeeView orgId={primary.organizationId} />}
      {/* An ACTIVE org admin may also manage AI coworker coaching: the API already authorizes that role. Identity screen unchanged. */}
      {primary && view === "identity" && primary.role === "org_admin" && config.coachingStudioEnabled && <ScenariosSection orgId={primary.organizationId} />}
    </div>
    </WorkspaceShell>
  );
}
