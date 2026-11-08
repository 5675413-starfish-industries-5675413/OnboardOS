import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AssignmentView } from "@onboardos/contracts";
import { listAssignments, startAssignment } from "../lib/api.js";
import { assignmentStatusLabel, assignmentStatusTone, describeApiError, toneClass } from "../lib/views.js";

/**
 * Employee: see assigned incidents, start (or resume) the investigation.
 * Starting is idempotent on the server, so a double click or a retry returns
 * the same session instead of creating a second one.
 */
export function EmployeeView({ orgId }: { orgId: string }) {
  const navigate = useNavigate();
  const [assignments, setAssignments] = useState<AssignmentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setAssignments(await listAssignments(orgId));
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onStart(assignmentId: string) {
    setStartingId(assignmentId);
    setError(null);
    try {
      const { session } = await startAssignment(assignmentId);
      // The session page loads authoritative state itself, so a refresh there is safe.
      navigate(`/sessions/${encodeURIComponent(session.sessionId)}`);
    } catch (err) {
      setError(describeApiError(err));
      setStartingId(null);
    }
  }

  return (
    <div className="card">
      <div className="row">
        <h2>Your assignments</h2>
        <button className="btn btn-sm" onClick={() => void load()} disabled={startingId !== null}>
          Refresh
        </button>
      </div>
      {loading && <p role="status">Loading your assignments…</p>}
      {error && <div className="error" role="alert">{error}</div>}
      {!loading && assignments.length === 0 && (
        <p className="muted">Nothing has been assigned to you yet. Ask your manager.</p>
      )}
      {assignments.map((a) => (
        <div key={a.assignmentId} style={{ padding: ".75rem 0", borderTop: "1px solid #e2e8f0" }}>
          <div className="row">
            <strong>{a.scenarioTitle}</strong>
            <span className={toneClass(assignmentStatusTone(a.status))}>{assignmentStatusLabel(a.status)}</span>
          </div>
          <div className="muted">
            Assigned {new Date(a.createdAt).toLocaleString()}
            {a.attemptNumber > 1 && <> · attempt {a.attemptNumber}</>}
          </div>
          {(a.status === "ASSIGNED" || a.status === "IN_PROGRESS") && (
            <button
              className="btn"
              style={{ marginTop: ".6rem" }}
              onClick={() => void onStart(a.assignmentId)}
              disabled={startingId !== null}
            >
              {startingId === a.assignmentId
                ? "Opening…"
                : a.status === "ASSIGNED"
                  ? "Start investigation"
                  : "Resume investigation"}
            </button>
          )}
          {a.sessionId && a.status !== "ASSIGNED" && a.status !== "IN_PROGRESS" && (
            <button
              className={a.status === "REVISION_REQUESTED" ? "btn btn-sm" : "btn"}
              style={{ marginTop: ".6rem", marginRight: ".5rem" }}
              onClick={() => navigate(`/sessions/${encodeURIComponent(a.sessionId ?? "")}`)}
              disabled={startingId !== null}
            >
              {a.status === "REVISION_REQUESTED" ? "Read the feedback" : "View your submission"}
            </button>
          )}
          {a.status === "REVISION_REQUESTED" && (
            <button
              className="btn"
              style={{ marginTop: ".6rem" }}
              onClick={() => void onStart(a.assignmentId)}
              disabled={startingId !== null}
            >
              {startingId === a.assignmentId ? "Opening…" : `Begin attempt ${a.attemptNumber + 1}`}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
