import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { CoachingScenarioSummary } from "@onboardos/contracts";
import { listCoachingScenarios } from "../lib/api.js";
import { describeApiError } from "../lib/views.js";

/**
 * The supported (executable) scenarios and this organization's AI coaching status, with a link to configure each.
 * `scenarios === null` means "not loaded yet"; an empty list means the server returned none. Neither is guessed.
 */
export function ScenariosCard({ scenarios, error }: { scenarios: CoachingScenarioSummary[] | null; error: string | null }) {
  return (
    <div className="card" data-testid="scenarios">
      <h2>Scenarios</h2>
      <p className="muted">Scenarios available to assign. Configure how the AI coworker coaches employees on each one.</p>
      {error && <div className="error" role="alert">{error}</div>}
      {!error && scenarios === null && <p role="status">Loading scenarios…</p>}
      {!error && scenarios !== null && scenarios.length === 0 && <p className="muted">No supported scenarios are available.</p>}
      {scenarios !== null && scenarios.length > 0 && (
        <table className="data">
          <caption className="sr-only">Supported scenarios</caption>
          <thead><tr><th scope="col">Scenario</th><th scope="col">Role</th><th scope="col">AI coaching</th><th scope="col"><span className="sr-only">Configure</span></th></tr></thead>
          <tbody>
            {scenarios.map((x) => (
              <tr key={x.scenarioId}>
                <td>{x.title}</td>
                <td>{x.targetRole ?? "—"}</td>
                <td>{x.currentProfileVersion ? `Your version ${x.currentProfileVersion}` : "Platform built-in"}{x.hasDraft ? " · draft saved" : ""}</td>
                <td><Link className="btn btn-sm" to={`/scenarios/${encodeURIComponent(x.scenarioId)}/coaching`} aria-label={`Configure AI coworker for ${x.title}`}>Configure AI coworker</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Loads the list itself. Used where the screen has no other need for it (the org admin's screen). */
export function ScenariosSection({ orgId }: { orgId: string }) {
  const [scenarios, setScenarios] = useState<CoachingScenarioSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    listCoachingScenarios(orgId).then(
      (r) => { if (active) setScenarios(r.scenarios); },
      (e: unknown) => { if (active) setError(describeApiError(e)); },
    );
    return () => { active = false; };
  }, [orgId]);
  return <ScenariosCard scenarios={scenarios} error={error} />;
}
