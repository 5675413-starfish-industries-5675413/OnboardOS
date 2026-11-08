import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import type { MeResponse } from "@onboardos/contracts";
import { getMe } from "../lib/api.js";
import { config } from "../lib/config.js";
import { describeApiError } from "../lib/views.js";
import { WorkspaceShell } from "../components/WorkspaceShell.js";
import { CoachingStudio } from "../views/CoachingStudio.js";

export const LEAVE_WARNING = "You have unsaved changes to the AI coworker settings. Leave this page and lose them?";

/**
 * Manager Coaching Studio page. Managers and org admins may use it (the API authorizes exactly those two roles); the
 * organization is the one the SERVER reports for this user (GET /v1/me). The check here only decides whether to draw the
 * editor: every request it makes is authorized again by the API. With the feature flag off it does nothing, not even a request.
 */
export function CoachingPage() {
  if (!config.coachingStudioEnabled) return <Navigate to="/app" replace />;
  return <CoachingPageInner />;
}

function CoachingPageInner() {
  const { scenarioId = "" } = useParams();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const onDirtyChange = useCallback((d: boolean) => setDirty(d), []);

  useEffect(() => {
    let active = true;
    getMe().then(
      (m) => { if (active) setMe(m); },
      (e: unknown) => { if (active) setError(describeApiError(e)); },
    );
    return () => { active = false; };
  }, []);

  const membership = me?.memberships.find((m) => m.role === "manager" || m.role === "org_admin");

  return (
    <WorkspaceShell area="Coaching" organization={membership?.organizationName} onLeave={() => !dirty || window.confirm(LEAVE_WARNING)}>
    <div className="container-wide">
      <div className="card">
        <div className="row">
          <h1>AI coworker settings</h1>
          <Link
            className="btn btn-sm"
            to="/app"
            onClick={(e) => { if (dirty && !window.confirm(LEAVE_WARNING)) e.preventDefault(); }}
          >
            Back to dashboard
          </Link>
        </div>
      </div>
      {error && <div className="card"><div className="error" role="alert">{error}</div></div>}
      {!error && !me && <div className="card"><p role="status">Loading…</p></div>}
      {me && !membership && <div className="card"><div className="error" role="alert">Only managers and administrators can configure the AI coworker.</div></div>}
      {membership && <CoachingStudio orgId={membership.organizationId} scenarioId={scenarioId} onDirtyChange={onDirtyChange} />}
    </div>
    </WorkspaceShell>
  );
}
