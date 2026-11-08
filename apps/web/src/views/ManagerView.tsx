import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AssignableEmployee, AssignmentView } from "@onboardos/contracts";
import type { CoachingScenarioSummary } from "@onboardos/contracts";
import { createAssignment, listAssignableEmployees, listAssignments, listCoachingScenarios } from "../lib/api.js";
import { config } from "../lib/config.js";
import { assignmentCoachingLabel, newAssignmentCoachingLine } from "../lib/coaching.js";
import { ScenariosCard } from "./ScenariosCard.js";
import {
  assignmentStatusLabel,
  displayPersonName,
  assignmentStatusTone,
  describeApiError,
  hasAssignment,
  mergeAssignment,
  reviewQueue,
  toneClass,
} from "../lib/views.js";

/**
 * Manager: assign INC-104 to an employee on their team and see the persisted
 * assignments. Who the user is, which employees are eligible, and what they may
 * do are all decided by the server; this view only displays and requests.
 */
export function ManagerView({ orgId }: { orgId: string }) {
  const [employees, setEmployees] = useState<AssignableEmployee[]>([]);
  const [assignments, setAssignments] = useState<AssignmentView[]>([]);
  const [selected, setSelected] = useState("");
  const [scenarios, setScenarios] = useState<CoachingScenarioSummary[] | null>(null);
  const [scenariosError, setScenariosError] = useState<string | null>(null);
  const studio = config.coachingStudioEnabled;
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [emps, asg] = await Promise.all([listAssignableEmployees(orgId), listAssignments(orgId)]);
      setEmployees(emps.employees);
      setAssignments(asg);
      if (studio) {
        // Non-blocking: the dashboard works without it, and the failure is shown rather than hidden.
        listCoachingScenarios(orgId).then(
          (r) => { setScenarios(r.scenarios); setScenariosError(null); },
          (e: unknown) => setScenariosError(describeApiError(e)),
        );
      }
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setLoading(false);
    }
  }, [orgId, studio]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onAssign() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await createAssignment(orgId, selected);
      // Show exactly what the server persisted and returned.
      setAssignments((current) => mergeAssignment(current, result.assignment));
      setNotice(
        result.created
          ? "INC-104 assigned."
          : "That employee already has INC-104 assigned; nothing was duplicated.",
      );
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  const alreadyAssigned = selected !== "" && hasAssignment(assignments, selected);
  const queue = reviewQueue(assignments);
  const attemptBySub = new Map(assignments.flatMap((a) => (a.employee ? [[a.employee.userSub, a.attemptNumber] as const] : [])));
  const sharedNames = new Map<string, number>();
  for (const person of employees) {
    const shown = displayPersonName(person.displayName);
    sharedNames.set(shown, (sharedNames.get(shown) ?? 0) + 1);
  }
  const personLabel = (userSub: string, storedName: string) => {
    const shown = displayPersonName(storedName);
    const attempt = attemptBySub.get(userSub);
    return (sharedNames.get(shown) ?? 0) > 1 && attempt ? `${shown} (attempt ${attempt})` : shown;
  };

  return (
    <>
      <div className="card">
        <h2>Assign INC-104</h2>
        <p>Assign the checkout-timeout incident to an employee on your team.</p>
        {studio && <p className="muted" data-testid="new-assignment-coaching">{newAssignmentCoachingLine(scenarios?.find((x) => x.scenarioId === "inc-104")?.currentProfileVersion)}</p>}
        {loading ? (
          <p role="status">Loading your team…</p>
        ) : (
          <div className="toolbar">
            <div>
              <label htmlFor="employee">Employee</label>
              <select
                id="employee"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                disabled={busy || employees.length === 0}
              >
                <option value="">
                  {employees.length === 0 ? "No eligible employees" : "Select an employee…"}
                </option>
                {employees.map((e) => (
                  <option key={e.userSub} value={e.userSub}>
                    {personLabel(e.userSub, e.displayName)}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn" onClick={onAssign} disabled={!selected || busy}>
              {busy ? "Assigning…" : alreadyAssigned ? "Already assigned" : "Assign INC-104"}
            </button>
          </div>
        )}
        {notice && <div className="info" role="status">{notice}</div>}
        {error && <div className="error" role="alert">{error}</div>}
      </div>

      {studio && <ScenariosCard scenarios={scenarios} error={scenariosError} />}

      <div className="card" data-testid="review-queue">
        <div className="row">
          <h2>Review queue</h2>
          <button className="btn btn-sm" onClick={() => void load()} disabled={busy}>Refresh</button>
        </div>
        {queue.waiting.length === 0 ? (
          <p className="muted">Nothing is waiting for your review. New submissions can take a moment to appear; press Refresh.</p>
        ) : (
          <table className="data">
            <caption className="sr-only">Submissions awaiting your review</caption>
            <thead>
              <tr><th scope="col">Employee</th><th scope="col">Incident</th><th scope="col">Attempt</th><th scope="col"><span className="sr-only">Review</span></th></tr>
            </thead>
            <tbody>
              {queue.waiting.map((a) => (
                <tr key={a.assignmentId}>
                  <td>{a.employee ? personLabel(a.employee.userSub, a.employee.displayName) : "—"}</td>
                  <td>{a.scenarioTitle}</td>
                  <td>{a.attemptNumber}</td>
                  <td>
                    <Link className="btn btn-sm" to={`/reviews/${encodeURIComponent(a.latestSubmissionId ?? "")}`}>
                      Review
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {queue.decided.length > 0 && (
          <p className="muted">
            Decided:{" "}
            {queue.decided.map((a, i) => (
              <span key={a.assignmentId}>
                {i > 0 && " · "}
                <Link to={`/reviews/${encodeURIComponent(a.latestSubmissionId ?? "")}`}>
                  {a.employee ? personLabel(a.employee.userSub, a.employee.displayName) : "Employee"} ({assignmentStatusLabel(a.status).toLowerCase()})
                </Link>
              </span>
            ))}
          </p>
        )}
      </div>

      <div className="card">
        <div className="row">
          <h2>Your assignments</h2>
          <button className="btn btn-sm" onClick={() => void load()} disabled={busy}>Refresh</button>
        </div>
        {assignments.length === 0 ? (
          <p className="muted">No assignments yet.</p>
        ) : (
          <table className="data">
            <caption className="sr-only">Assignments you have created</caption>
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col">Incident</th>
                <th scope="col">Status</th>
                {studio && <th scope="col">AI coaching</th>}
                <th scope="col">Assigned</th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.assignmentId}>
                  <td>{a.employee ? personLabel(a.employee.userSub, a.employee.displayName) : "—"}</td>
                  <td>{a.scenarioTitle}</td>
                  <td>
                    <span className={toneClass(assignmentStatusTone(a.status))}>
                      {assignmentStatusLabel(a.status)}
                    </span>
                  </td>
                  {studio && <td>{assignmentCoachingLabel(a.coaching)}</td>}
                  <td className="muted">{new Date(a.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
