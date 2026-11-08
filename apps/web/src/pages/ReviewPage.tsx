import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { ReviewBundle, ReviewDecision } from "@onboardos/contracts";
import { ApiError, fetchReview, postReviewDecision } from "../lib/api.js";
import { WorkspaceShell } from "../components/WorkspaceShell.js";
import {
  REPORT_FIELDS,
  assignmentStatusLabel,
  assignmentStatusTone,
  describeApiError,
  displayPersonName,
  toneClass,
  validateDecision,
} from "../lib/views.js";

/**
 * Manager review of ONE frozen submission.
 *
 * Everything shown is the server's persisted record; nothing here is computed in the browser and
 * the evidence is read-only. Who may open this page and who may decide is re-checked by the API on
 * every request: reaching this URL proves nothing, and an unauthorized caller simply gets "not found".
 */
export function ReviewPage() {
  const { submissionId = "" } = useParams();
  const navigate = useNavigate();
  const [bundle, setBundle] = useState<ReviewBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [decision, setDecision] = useState<ReviewDecision | "">("");
  const [feedback, setFeedback] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleAuth = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiError && err.status === 401) {
        navigate("/", { replace: true, state: { reason: "expired" } });
        return true;
      }
      return false;
    },
    [navigate],
  );

  const load = useCallback(async () => {
    try {
      setBundle(await fetchReview(submissionId));
      setError(null);
    } catch (err) {
      if (!handleAuth(err)) setError(describeApiError(err));
    } finally {
      setLoading(false);
    }
  }, [submissionId, handleAuth]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onDecide() {
    const check = validateDecision(decision, feedback);
    if (!check.ok || decision === "" || saving) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      setBundle(await postReviewDecision(submissionId, decision, feedback));
      setNotice(decision === "APPROVE" ? "Approved. The decision is final." : "Revision requested. The employee can now begin the next attempt.");
    } catch (err) {
      if (handleAuth(err)) return;
      setError(describeApiError(err));
      await load(); // show what the server actually holds (e.g. someone else already decided)
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <WorkspaceShell area="Review">
        <div className="card"><p role="status">Loading the submission…</p></div>
      </WorkspaceShell>
    );
  }

  if (!bundle) {
    return (
      <WorkspaceShell area="Review">
        <div className="card">
          <h1>Submission unavailable</h1>
          {error && <div className="error" role="alert">{error}</div>}
          <Link to="/app" className="btn btn-sm">Back</Link>
        </div>
      </WorkspaceShell>
    );
  }

  const { submission: sub, employee, assignment } = bundle;
  const run = sub.testRun;
  const review = sub.review;
  const decisionCheck = validateDecision(decision, feedback);

  return (
    <WorkspaceShell area="Review">
    <div className="container-wide">
      <div className="card">
        <div className="row">
          <h1>Review: {assignment.scenarioTitle}</h1>
          <Link to="/app" className="btn btn-sm">Back</Link>
        </div>
        <p>
          <strong>{displayPersonName(employee.displayName)}</strong> · attempt {sub.attemptNumber} · submitted{" "}
          {new Date(sub.submittedAt).toLocaleString()}
        </p>
        <p className="muted">
          Assignment status:{" "}
          <span className={toneClass(assignmentStatusTone(assignment.status))}>{assignmentStatusLabel(assignment.status)}</span>
        </p>
        <div className="banner banner-warn" role="note">
          <strong>Evaluation: {sub.evaluation.status === "NOT_CONFIGURED" ? "not configured" : sub.evaluation.status}.</strong>{" "}
          {sub.evaluation.message} Nothing below was written or scored by AI.
        </div>
        {notice && <div className="info" role="status">{notice}</div>}
        {error && <div className="error" role="alert">{error}</div>}
        {!bundle.canDecide && !review && (
          <div className="info" role="status">This is not the submission currently awaiting review, so it can only be read.</div>
        )}
      </div>

      <div className="card">
        <h2>Employee report</h2>
        {REPORT_FIELDS.map(({ key, label }) => (
          <div key={key}>
            <h3 style={{ fontSize: ".95rem", margin: ".9rem 0 .25rem" }}>{label}</h3>
            <div className="prewrap">{sub.report[key]}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Frozen evidence</h2>
        <p className="muted">Read-only. This is what the server held when the employee submitted; later activity cannot change it.</p>
        <p data-testid="frozen-config">
          Configuration revision {sub.config.revision === 0 ? "0 (baseline)" : sub.config.revision} · request timeout {sub.config.snapshot.request_timeout_ms} ms
        </p>
        <div className="banner banner-aws" role="note">
          <strong>Real execution.</strong> Tests ran in a dedicated AWS Lambda function against this exact
          revision. The investigation diagnostics the employee read were <em>synthetic</em>.
        </div>
        <div className="row">
          <strong>
            Test result
          </strong>
          <span className={toneClass(run.status === "PASSED" ? "ok" : "bad")}>
            {run.status === "PASSED" ? "Passed" : "Failed"} {run.passedCount}/{run.totalCount}
          </span>
        </div>
        {run.status === "FAILED" && (
          <p className="field-error">The submitted configuration did not pass the tests. Compare this with what the report claims.</p>
        )}
        {run.executor && (
          <p className="muted" data-testid="review-executor">
            Ran on AWS Lambda in {run.executor.region}
            {run.completedAt && <> · {new Date(run.completedAt).toLocaleString()}</>}
          </p>
        )}
        <table className="data">
          <caption className="sr-only">Test case results</caption>
          <thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
          <tbody>
            {run.cases.map((c) => (
              <tr key={c.caseId}>
                <td>{c.name}</td>
                <td className={c.status === "FAIL" ? "lvl-ERROR" : undefined}>{c.status === "PASS" ? "Pass" : "Fail"}</td>
                <td>{c.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          Investigated: ticket {sub.investigation.ticketOpened ? "✓" : "✗"} · runbook {sub.investigation.runbookOpened ? "✓" : "✗"} ·
          diagnostics {sub.investigation.diagnosticsOpened ? "✓" : "✗"}
        </p>
      </div>

      <div className="card">
        <h2>Evidence timeline</h2>
        <p className="muted">Events the server recorded for this attempt, up to the moment of submission.</p>
        <ol className="timeline" data-testid="timeline">
          {bundle.timeline.map((e) => (
            <li key={e.sequence}>
              <span className="muted">{new Date(e.occurredAt).toLocaleString()}</span>{" "}
              <span className="pill">{e.actor === "EMPLOYEE" ? "Employee" : e.actor === "SYSTEM" ? "System" : "Reviewer"}</span>{" "}
              {e.summary}
            </li>
          ))}
        </ol>
      </div>

      {bundle.history.length > 1 && (
        <div className="card">
          <h2>All attempts</h2>
          <table className="data">
            <caption className="sr-only">Attempts and decisions</caption>
            <thead><tr><th scope="col">Attempt</th><th scope="col">Submitted</th><th scope="col">Test result</th><th scope="col">Decision</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
            <tbody>
              {bundle.history.map((h) => (
                <tr key={h.submissionId}>
                  <td>{h.attemptNumber}{h.submissionId === sub.submissionId && " (this)"}</td>
                  <td>{new Date(h.submittedAt).toLocaleString()}</td>
                  <td>{h.testStatus === "PASSED" ? "Passed" : "Failed"} (revision {h.configRevision})</td>
                  <td>
                    {h.review ? (
                      <>
                        {h.review.decision === "APPROVE" ? "Approved" : "Revision requested"}
                        {h.review.feedback && <div className="prewrap muted">{h.review.feedback}</div>}
                      </>
                    ) : (
                      <span className="muted">Awaiting review</span>
                    )}
                  </td>
                  <td>
                    {h.submissionId !== sub.submissionId && (
                      <Link className="btn btn-sm" to={`/reviews/${encodeURIComponent(h.submissionId)}`}>Open</Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Decision</h2>
        {review ? (
          <div data-testid="recorded-decision">
            <p>
              <span className={toneClass(review.decision === "APPROVE" ? "ok" : "bad")}>
                {review.decision === "APPROVE" ? "Approved" : "Revision requested"}
              </span>{" "}
              by {review.reviewerDisplayName} on {new Date(review.decidedAt).toLocaleString()}. This decision is final.
            </p>
            {review.feedback && <div className="prewrap">{review.feedback}</div>}
          </div>
        ) : bundle.canDecide ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void onDecide();
            }}
            noValidate
          >
            <fieldset>
              <legend>Your decision (final; it cannot be changed)</legend>
              <label className="radio">
                <input type="radio" name="decision" value="APPROVE" checked={decision === "APPROVE"} onChange={() => setDecision("APPROVE")} disabled={saving} />
                Approve this submission
              </label>
              <label className="radio">
                <input type="radio" name="decision" value="REQUEST_REVISION" checked={decision === "REQUEST_REVISION"} onChange={() => setDecision("REQUEST_REVISION")} disabled={saving} />
                Request a revision
              </label>
            </fieldset>
            <label htmlFor="feedback">
              {decision === "REQUEST_REVISION" ? "Feedback for the employee (required)" : "Note for the employee (optional)"}
            </label>
            <textarea
              id="feedback"
              rows={4}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              aria-invalid={showErrors && !decisionCheck.ok ? true : undefined}
              aria-describedby={showErrors && !decisionCheck.ok ? "decision-error" : undefined}
              disabled={saving}
            />
            {showErrors && !decisionCheck.ok && (
              <div id="decision-error" className="field-error" role="alert">{decisionCheck.message}</div>
            )}
            <div style={{ marginTop: ".8rem" }}>
              <button className="btn" type="submit" disabled={saving}>{saving ? "Recording…" : "Record decision"}</button>
            </div>
          </form>
        ) : (
          <p className="muted">No decision can be recorded on this submission.</p>
        )}
      </div>
    </div>
    </WorkspaceShell>
  );
}
