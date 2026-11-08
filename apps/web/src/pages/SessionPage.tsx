import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { SessionView, SubmissionView, TestRunView } from "@onboardos/contracts";
import { REPORT_FIELD_MAX } from "@onboardos/contracts";
import {
  ApiError,
  fetchSession,
  fetchTestRun,
  postSessionAction,
  requestTestRun,
  saveConfig,
  startAssignment,
  submitReport,
} from "../lib/api.js";
import {
  EMPTY_REPORT,
  REPORT_FIELDS,
  actionForTab,
  assignmentStatusLabel,
  canRunTests,
  describeApiError,
  evidenceNote,
  parseTimeoutInput,
  runBadge,
  shortHash,
  submissionReadiness,
  toneClass,
  validateReport,
  type ReportDraft,
  type Tab,
} from "../lib/views.js";
import { config } from "../lib/config.js";
import { WorkspaceShell } from "../components/WorkspaceShell.js";
import { CoworkerPanel } from "../views/CoworkerPanel.js";

/** How often a PENDING run is re-read from the server. */
const POLL_MS = 2000;

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "ticket", label: "Ticket" },
  { id: "runbook", label: "Runbook" },
  { id: "diagnostics", label: "Diagnostics" },
];

/**
 * The employee's workplace session for an assigned incident.
 *
 * The page never keeps its own idea of "what happened": every load asks the
 * server for the authoritative state, and every change is a server-validated
 * action whose result replaces local state. A refresh therefore always shows the
 * persisted truth.
 */
export function SessionPage() {
  const { sessionId = "" } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionView | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<ReportDraft>(EMPTY_REPORT);
  const [showReportErrors, setShowReportErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [beginning, setBeginning] = useState(false);
  // One Idempotency-Key per distinct report: a retry of the same content reuses it, so a lost
  // response can never create a second submission; editing the report starts a new key.
  const idempotencyKey = useRef<string | null>(null);

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

  useEffect(() => {
    let active = true; // guards against updates after unmount (StrictMode double effect)
    setLoading(true);
    fetchSession(sessionId)
      .then((s) => {
        if (!active) return;
        setSession(s);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active || handleAuth(err)) return;
        setError(describeApiError(err));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sessionId, handleAuth]);

  // The editor always starts from the SERVER's current config; it resets when a new revision lands.
  const serverTimeout = session?.config.request_timeout_ms;
  const serverRevision = session?.configRevision;
  useEffect(() => {
    if (serverTimeout !== undefined) setDraft(String(serverTimeout));
  }, [serverTimeout, serverRevision]);

  // While a run is PENDING, ask the server for it. The server also closes a run that never finished.
  const activeRunId = session?.activeTestRunId ?? null;
  useEffect(() => {
    if (!activeRunId || running) return;
    let active = true;
    const timer = setInterval(() => {
      fetchTestRun(sessionId, activeRunId)
        .then((r) => {
          if (active) setSession(r.session);
        })
        .catch((err: unknown) => {
          if (active && !handleAuth(err)) setError(describeApiError(err));
        });
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [activeRunId, running, sessionId, handleAuth]);

  async function reloadAfterConflict(err: unknown, id: string) {
    if (err instanceof ApiError && err.status === 409) {
      // Our view was stale: replace it with the server's truth rather than guessing.
      try {
        setSession(await fetchSession(id));
      } catch (reloadErr) {
        if (!handleAuth(reloadErr)) setError(describeApiError(reloadErr));
      }
    }
  }

  async function onSaveConfig() {
    if (!session || busy || running) return;
    const parsed = parseTimeoutInput(draft);
    if (!parsed.ok) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await saveConfig(session.sessionId, session.stateVersion, { request_timeout_ms: parsed.value });
      setSession(next);
      setNotice(`Saved as revision ${next.configRevision}. Run the tests to check it.`);
    } catch (err) {
      if (handleAuth(err)) return;
      setError(describeApiError(err));
      await reloadAfterConflict(err, session.sessionId);
    } finally {
      setBusy(false);
    }
  }

  function onReportChange(key: keyof ReportDraft, value: string) {
    idempotencyKey.current = null;
    setReport((r) => ({ ...r, [key]: value }));
  }

  async function onSubmitReport() {
    if (!session || submitting || busy || running) return;
    const check = validateReport(report);
    const ready = submissionReadiness(session);
    if (!check.ok) {
      setShowReportErrors(true);
      return;
    }
    if (!ready.ready) return;
    idempotencyKey.current ??= crypto.randomUUID();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const r = await submitReport(
        session.sessionId,
        {
          expectedStateVersion: session.stateVersion,
          testRunId: ready.run.testRunId,
          configRevision: session.configRevision,
          configHash: session.configHash,
          report: check.report,
        },
        idempotencyKey.current,
      );
      setSession(r.session);
      setNotice(r.created ? "Submitted for review. Your evidence is now frozen." : "That report was already submitted; showing the original.");
    } catch (err) {
      if (handleAuth(err)) return;
      setError(describeApiError(err));
      // Whatever happened, show what the server actually holds.
      try {
        setSession(await fetchSession(session.sessionId));
      } catch (reloadErr) {
        if (!handleAuth(reloadErr)) setError(describeApiError(reloadErr));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function onBeginNextAttempt() {
    if (!session || beginning) return;
    setBeginning(true);
    setError(null);
    try {
      const r = await startAssignment(session.assignmentId);
      navigate(`/sessions/${encodeURIComponent(r.session.sessionId)}`);
    } catch (err) {
      if (!handleAuth(err)) setError(describeApiError(err));
    } finally {
      setBeginning(false);
    }
  }

  async function onRunTests() {
    if (!session || !canRunTests(session, busy || running)) return;
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      const r = await requestTestRun(session.sessionId, session.stateVersion);
      setSession(r.session);
    } catch (err) {
      if (handleAuth(err)) return;
      setError(describeApiError(err));
      // The run may still be recorded server-side; always show what the server holds.
      try {
        setSession(await fetchSession(session.sessionId));
      } catch (reloadErr) {
        if (!handleAuth(reloadErr)) setError(describeApiError(reloadErr));
      }
    } finally {
      setRunning(false);
    }
  }

  async function selectTab(next: Tab) {
    if (!session || busy) return;
    setTab(next);
    setError(null);
    setNotice(null);

    // Record the first time each item is opened. Already-opened items add nothing.
    const action = actionForTab(session, next);
    if (!action) return;

    setBusy(true);
    try {
      setSession(await postSessionAction(session.sessionId, session.stateVersion, action));
    } catch (err) {
      if (handleAuth(err)) return;
      setError(describeApiError(err));
      if (err instanceof ApiError && err.status === 409) {
        // Our view was stale: replace it with the server's truth rather than guessing.
        try {
          setSession(await fetchSession(session.sessionId));
        } catch (reloadErr) {
          if (!handleAuth(reloadErr)) setError(describeApiError(reloadErr));
        }
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <WorkspaceShell area="Investigation">
        <div className="card"><p role="status">Loading your investigation…</p></div>
      </WorkspaceShell>
    );
  }

  if (!session) {
    return (
      <WorkspaceShell area="Investigation">
        <div className="card">
          <h1>Investigation unavailable</h1>
          {error && <div className="error" role="alert">{error}</div>}
          <Link to="/app" className="btn btn-sm">Back to your assignments</Link>
        </div>
      </WorkspaceShell>
    );
  }

  const { scenario } = session;

  return (
    <WorkspaceShell area="Investigation">
    <div className="container-wide">
      <div className="card">
        <div className="row">
          <h1>{scenario.title}</h1>
          <Link to="/app" className="btn btn-sm">Back</Link>
        </div>
        <p>{scenario.summary}</p>
        <p className="muted">
          <span className="pill pill-progress">{session.phase === "INVESTIGATING" ? "Investigating" : session.phase === "SUBMITTED" ? "Submitted" : session.phase}</span>{" "}
          Server state version {session.stateVersion}
          {session.startedAt && <> · started {new Date(session.startedAt).toLocaleString()}</>}
        </p>
        {notice && <div className="info" role="status">{notice}</div>}
        {error && <div className="error" role="alert">{error}</div>}

        <div className="tabs" role="tablist" aria-label="Incident material">
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              role="tab"
              className="tab"
              aria-selected={tab === t.id}
              aria-controls="panel"
              disabled={busy}
              onClick={() => void selectTab(t.id)}
            >
              {t.label}
              {session.viewed[t.id] && <span className="sr-only"> (opened)</span>}
              {session.viewed[t.id] && <span aria-hidden="true"> ✓</span>}
            </button>
          ))}
        </div>

        <div id="panel" role="tabpanel" aria-labelledby={tab ? `tab-${tab}` : undefined}>
          {tab === null && (
            <p className="muted">
              Open the ticket, runbook and diagnostics to investigate. Each item you open is recorded.
            </p>
          )}
          {tab === "ticket" && <TicketPanel session={session} />}
          {tab === "runbook" && <RunbookPanel session={session} />}
          {tab === "diagnostics" && <DiagnosticsPanel session={session} />}
        </div>
      </div>

      <ConfigCard
        session={session}
        draft={draft}
        onDraft={setDraft}
        onSave={() => void onSaveConfig()}
        disabled={busy || running || submitting || session.phase !== "INVESTIGATING"}
        locked={session.phase !== "INVESTIGATING"}
      />

      <TestRunsCard
        session={session}
        running={running}
        canRun={canRunTests(session, busy || running || submitting)}
        onRun={() => void onRunTests()}
      />

      {config.coworkerEnabled && (
        <CoworkerPanel sessionId={session.sessionId} phase={session.phase} onAuthExpired={handleAuth} />
      )}

      {session.phase === "INVESTIGATING" ? (
        <ReportCard
          session={session}
          report={report}
          showErrors={showReportErrors}
          submitting={submitting}
          disabled={busy || running}
          onChange={onReportChange}
          onSubmit={() => void onSubmitReport()}
        />
      ) : (
        session.submission && (
          <SubmissionCard
            session={session}
            submission={session.submission}
            beginning={beginning}
            onBegin={() => void onBeginNextAttempt()}
          />
        )
      )}

      <PreviousAttempts session={session} />
    </div>
    </WorkspaceShell>
  );
}

function TicketPanel({ session }: { session: SessionView }) {
  const t = session.scenario.ticket;
  return (
    <section aria-label="Ticket">
      <div className="row">
        <h2>{t.id}: {t.title}</h2>
        <span className="pill">{t.severity}</span>
      </div>
      <p className="muted">
        {t.service} · {t.status} · reported by {t.reporter} · {new Date(t.reportedAt).toLocaleString()}
      </p>
      <p className="prewrap">{t.description}</p>
      {t.comments.map((c) => (
        <div className="comment" key={`${c.at}-${c.author}`}>
          <div className="muted">{c.author} · {new Date(c.at).toLocaleString()}</div>
          <div className="prewrap">{c.body}</div>
        </div>
      ))}
    </section>
  );
}

function RunbookPanel({ session }: { session: SessionView }) {
  const r = session.scenario.runbook;
  return (
    <section aria-label="Runbook">
      <h2>{r.title}</h2>
      {r.sections.map((s) => (
        <div key={s.heading}>
          <h3 style={{ fontSize: ".95rem", margin: ".9rem 0 .25rem" }}>{s.heading}</h3>
          <div className="prewrap">{s.body}</div>
        </div>
      ))}
    </section>
  );
}

function DiagnosticsPanel({ session }: { session: SessionView }) {
  const d = session.scenario.diagnostics;
  return (
    <section aria-label="Diagnostics">
      <h2>{d.title}</h2>
      {/* Invariant 9: synthetic incident data is never presented as real AWS telemetry. */}
      <div className="banner banner-warn" role="note">
        <strong>Synthetic data.</strong> {d.notice}
      </div>
      <table className="data">
        <caption className="sr-only">Synthetic log entries</caption>
        <thead>
          <tr>
            <th scope="col">Time (UTC)</th>
            <th scope="col">Level</th>
            <th scope="col">Service</th>
            <th scope="col">Message</th>
            <th scope="col">Upstream</th>
            <th scope="col">HTTP</th>
          </tr>
        </thead>
        <tbody>
          {d.entries.map((e, i) => (
            <tr key={`${e.timestamp}-${i}`}>
              <td className="mono">{e.timestamp.replace("T", " ").replace("Z", "")}</td>
              <td className={`lvl-${e.level}`}>{e.level}</td>
              <td>{e.service}</td>
              <td>{e.message}</td>
              <td className="mono">{e.upstreamLatencyMs !== undefined ? `${e.upstreamLatencyMs} ms` : ""}</td>
              <td className="mono">{e.httpStatus ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ConfigCard(props: {
  session: SessionView;
  draft: string;
  onDraft: (v: string) => void;
  onSave: () => void;
  disabled: boolean;
  locked: boolean;
}) {
  const { session, draft } = props;
  const parsed = parseTimeoutInput(draft);
  const unchanged = parsed.ok && parsed.value === session.config.request_timeout_ms;
  const errorId = "timeout-error";
  return (
    <div className="card">
      <h2>Configuration</h2>
      <p className="muted" data-testid="config-summary">
        {session.configRevision === 0 ? "Baseline (no revision saved yet)" : `Revision ${session.configRevision}`} ·{" "}
        <span className="mono">{shortHash(session.configHash)}</span>
      </p>
      <p className="mono" data-testid="config">
        {JSON.stringify(session.config)}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          props.onSave();
        }}
      >
        <div className="toolbar">
          <div>
            <label htmlFor="timeout-input">request_timeout_ms</label>
            <input
              id="timeout-input"
              type="number"
              inputMode="numeric"
              step={1}
              value={draft}
              onChange={(e) => props.onDraft(e.target.value)}
              aria-invalid={!parsed.ok}
              aria-describedby={parsed.ok ? undefined : errorId}
              disabled={props.disabled}
            />
          </div>
          <button className="btn" type="submit" disabled={props.disabled || !parsed.ok || unchanged}>
            Save as new revision
          </button>
        </div>
        {!parsed.ok && (
          <div id={errorId} className="field-error" role="alert">{parsed.message}</div>
        )}
      </form>
      <p className="muted">
        {props.locked
          ? "This attempt has been submitted, so the configuration is locked. Your earlier revisions remain below."
          : "Each save creates a new numbered revision that is never edited afterwards. The server validates the value."}
      </p>
      {session.revisions.length > 0 && (
        <table className="data">
          <caption className="sr-only">Saved configuration revisions</caption>
          <thead>
            <tr>
              <th scope="col">Revision</th>
              <th scope="col">request_timeout_ms</th>
              <th scope="col">Hash</th>
              <th scope="col">Saved</th>
            </tr>
          </thead>
          <tbody>
            {session.revisions.map((r) => (
              <tr key={r.revision}>
                <td>{r.revision}{r.revision === session.configRevision && <> <span className="pill pill-ok">current</span></>}</td>
                <td className="mono">{r.config.request_timeout_ms}</td>
                <td className="mono">{shortHash(r.configHash)}</td>
                <td>{new Date(r.savedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TestRunsCard(props: { session: SessionView; running: boolean; canRun: boolean; onRun: () => void }) {
  const { session } = props;
  const pending = props.running || session.activeTestRunId !== null;
  return (
    <div className="card">
      <h2>Tests</h2>
      <div className="banner banner-aws" role="note">
        <strong>Real execution.</strong> Tests run in a dedicated AWS Lambda function against the configuration revision
        you saved. This is separate from the <em>synthetic</em> diagnostics above, which are exercise data only.
      </div>
      <div className="toolbar">
        <button className="btn" type="button" disabled={!props.canRun} onClick={props.onRun}>
          Run tests on revision {session.configRevision}
        </button>
        {pending && <span role="status">Running on AWS Lambda…</span>}
      </div>
      <p className="muted" data-testid="evidence-summary">{evidenceSummary(session)}</p>
      {session.testRuns.length === 0 && <p className="muted">No test runs yet.</p>}
      {session.testRuns.map((run) => (
        <RunCard key={run.testRunId} run={run} />
      ))}
    </div>
  );
}

function evidenceSummary(session: SessionView): string {
  const e = session.currentEvidence;
  switch (e.status) {
    case "NONE": return "No test run covers the current configuration yet.";
    case "PENDING": return "A test run for the current configuration is in progress.";
    case "PASSED": return "The latest run for the current configuration passed.";
    case "FAILED": return "The latest run for the current configuration failed.";
    case "ERROR": return "The latest run for the current configuration did not produce results.";
  }
}

function RunCard({ run }: { run: TestRunView }) {
  const badge = runBadge(run);
  const tone = badge.tone === "ok" ? "pill-ok" : badge.tone === "bad" ? "pill-bad" : "pill-progress";
  return (
    <section className={run.stale ? "run run-stale" : "run"} aria-label={`Test run on revision ${run.configRevision}`} data-testid="test-run">
      <div className="row">
        <strong>
          Revision {run.configRevision}{" "}
          <span className="mono muted">{shortHash(run.configHash)} · {run.configSnapshot.request_timeout_ms} ms</span>
        </strong>
        <span>
          <span className={`pill ${tone}`}>{badge.label}</span>{" "}
          {run.status !== "PENDING" && (run.stale
            ? <span className="pill pill-stale" title="The configuration changed after this run">Stale</span>
            : <span className="pill">Current</span>)}
        </span>
      </div>
      {run.stale && (
        <p className="muted">This result is for an older configuration and does not reflect the current one.</p>
      )}
      {run.executor && (
        <p className="muted" data-testid="executor">
          Executed on AWS Lambda ({run.executor.region}) · runner request <span className="mono">{run.executor.runnerRequestId}</span>
          {run.executor.invokeRequestId && <> · invoke request <span className="mono">{run.executor.invokeRequestId}</span></>}
        </p>
      )}
      {run.errorMessage && <div className="error" role="alert">{run.errorMessage}</div>}
      {run.totalCount > 0 && (
        <>
          <p>{run.passedCount} of {run.totalCount} checks passed.</p>
          <table className="data">
            <caption className="sr-only">Test results</caption>
            <thead>
              <tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">Detail</th></tr>
            </thead>
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
        </>
      )}
    </section>
  );
}

function ReportCard(props: {
  session: SessionView;
  report: ReportDraft;
  showErrors: boolean;
  submitting: boolean;
  disabled: boolean;
  onChange: (key: keyof ReportDraft, value: string) => void;
  onSubmit: () => void;
}) {
  const { session, report } = props;
  const readiness = submissionReadiness(session);
  const check = validateReport(report);
  const errors = check.ok ? {} : check.errors;
  const blocked = !readiness.ready;
  return (
    <div className="card">
      <h2>Incident report</h2>
      <p className="muted">
        Attempt {session.attemptNumber}. Submitting freezes your report and the evidence below for your manager. After you
        submit, this attempt cannot be edited.
      </p>

      <div className="run" data-testid="submission-evidence">
        <strong>Evidence that will be submitted</strong>
        {readiness.ready ? (
          <>
            <p>
              Configuration revision {session.configRevision === 0 ? "0 (baseline)" : session.configRevision} ·{" "}
              <span className="mono">{shortHash(session.configHash)}</span> · {session.config.request_timeout_ms} ms
            </p>
            <p>
              Latest test run:{" "}
              <span className={toneClass(readiness.run.status === "PASSED" ? "ok" : "bad")}>
                {readiness.run.status === "PASSED" ? "Passed" : "Failed"}
              </span>{" "}
              {readiness.run.passedCount} of {readiness.run.totalCount} checks, executed on AWS Lambda.
            </p>
            <p className={readiness.run.status === "FAILED" ? "field-error" : "muted"}>
              {evidenceNote(readiness.run.status as "PASSED" | "FAILED")}
            </p>
          </>
        ) : (
          <p className="muted" role="status" data-testid="submission-blocked">{readiness.reason}</p>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit();
        }}
        noValidate
      >
        {REPORT_FIELDS.map(({ key, label, hint }) => {
          const id = `report-${key}`;
          const err = props.showErrors ? errors[key] : undefined;
          return (
            <div key={key} style={{ marginBottom: ".9rem" }}>
              <label htmlFor={id}>{label}</label>
              <textarea
                id={id}
                rows={4}
                value={report[key]}
                maxLength={REPORT_FIELD_MAX + 200}
                onChange={(e) => props.onChange(key, e.target.value)}
                aria-invalid={err ? true : undefined}
                aria-describedby={`${id}-hint${err ? ` ${id}-error` : ""}`}
                disabled={props.disabled || props.submitting}
              />
              <div id={`${id}-hint`} className="muted">
                {hint} ({report[key].trim().length}/{REPORT_FIELD_MAX})
              </div>
              {err && <div id={`${id}-error`} className="field-error" role="alert">{err}</div>}
            </div>
          );
        })}
        <button className="btn" type="submit" disabled={props.disabled || props.submitting || blocked}>
          {props.submitting ? "Submitting…" : "Submit for review"}
        </button>
        {blocked && <span className="muted"> {readiness.reason}</span>}
      </form>
    </div>
  );
}

function SubmissionCard(props: {
  session: SessionView;
  submission: SubmissionView;
  beginning: boolean;
  onBegin: () => void;
}) {
  const { submission: sub, session } = props;
  const review = sub.review;
  const status = review ? (review.decision === "APPROVE" ? "APPROVED" : "REVISION_REQUESTED") : "AWAITING_REVIEW";
  const tone = review ? (review.decision === "APPROVE" ? "ok" : "bad") : "warn";
  return (
    <div className="card" data-testid="submission-card">
      <div className="row">
        <h2>Attempt {sub.attemptNumber}: submitted</h2>
        <span className={toneClass(tone)}>{assignmentStatusLabel(status)}</span>
      </div>
      <p className="muted">Submitted {new Date(sub.submittedAt).toLocaleString()}. This attempt is frozen and cannot be edited.</p>

      {!review && (
        <div className="info" role="status">
          Waiting for your manager. {sub.evaluation.message}
        </div>
      )}
      {review?.decision === "APPROVE" && (
        <div className="banner banner-aws" role="status" data-testid="review-outcome">
          <strong>Approved</strong> by {review.reviewerDisplayName} on {new Date(review.decidedAt).toLocaleString()}.
          {review.feedback && <div className="prewrap">{review.feedback}</div>}
        </div>
      )}
      {review?.decision === "REQUEST_REVISION" && (
        <div className="banner banner-warn" role="status" data-testid="review-outcome">
          <strong>Revision requested</strong> by {review.reviewerDisplayName} on {new Date(review.decidedAt).toLocaleString()}.
          <div className="prewrap" style={{ marginTop: ".4rem" }}>{review.feedback}</div>
          <button className="btn" style={{ marginTop: ".7rem" }} onClick={props.onBegin} disabled={props.beginning}>
            {props.beginning ? "Opening…" : `Begin attempt ${session.attemptNumber + 1}`}
          </button>
        </div>
      )}

      <h3 style={{ fontSize: ".95rem", margin: ".9rem 0 .25rem" }}>Evidence submitted</h3>
      <p>
        Configuration revision {sub.config.revision} · <span className="mono">{shortHash(sub.config.configHash)}</span> ·{" "}
        {sub.config.snapshot.request_timeout_ms} ms. Test run{" "}
        <span className={toneClass(sub.testRun.status === "PASSED" ? "ok" : "bad")}>
          {sub.testRun.status === "PASSED" ? "Passed" : "Failed"}
        </span>{" "}
        {sub.testRun.passedCount} of {sub.testRun.totalCount}
        {sub.testRun.executor && (
          <> · executed on AWS Lambda ({sub.testRun.executor.region}), runner request{" "}
            <span className="mono">{sub.testRun.executor.runnerRequestId}</span></>
        )}
        .
      </p>
      {REPORT_FIELDS.map(({ key, label }) => (
        <div key={key}>
          <h3 style={{ fontSize: ".95rem", margin: ".9rem 0 .25rem" }}>{label}</h3>
          <div className="prewrap">{sub.report[key]}</div>
        </div>
      ))}
    </div>
  );
}

function PreviousAttempts({ session }: { session: SessionView }) {
  const earlier = session.submissions.filter((s) => s.attemptNumber !== session.attemptNumber);
  if (earlier.length === 0) return null;
  return (
    <div className="card" data-testid="previous-attempts">
      <h2>Earlier attempts</h2>
      <p className="muted">These are frozen and cannot change.</p>
      <table className="data">
        <caption className="sr-only">Earlier attempts and manager decisions</caption>
        <thead>
          <tr><th scope="col">Attempt</th><th scope="col">Submitted</th><th scope="col">Test result</th><th scope="col">Manager decision</th></tr>
        </thead>
        <tbody>
          {earlier.map((s) => (
            <tr key={s.submissionId}>
              <td>{s.attemptNumber}</td>
              <td>{new Date(s.submittedAt).toLocaleString()}</td>
              <td>{s.testStatus === "PASSED" ? "Passed" : "Failed"} (revision {s.configRevision})</td>
              <td>
                {s.review ? (
                  <>
                    <strong>{s.review.decision === "APPROVE" ? "Approved" : "Revision requested"}</strong>
                    {s.review.feedback && <div className="prewrap muted">{s.review.feedback}</div>}
                  </>
                ) : (
                  <span className="muted">Awaiting review</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
