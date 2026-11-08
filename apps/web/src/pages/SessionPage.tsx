import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { SessionView, TestRunView } from "@onboardos/contracts";
import {
  ApiError,
  fetchSession,
  fetchTestRun,
  postSessionAction,
  requestTestRun,
  saveConfig,
} from "../lib/api.js";
import {
  actionForTab,
  canRunTests,
  describeApiError,
  parseTimeoutInput,
  runBadge,
  shortHash,
  type Tab,
} from "../lib/views.js";

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
      <div className="container-wide">
        <div className="card"><p role="status">Loading your investigation…</p></div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="container-wide">
        <div className="card">
          <h1>Investigation unavailable</h1>
          {error && <div className="error" role="alert">{error}</div>}
          <Link to="/app" className="btn btn-sm">Back to your assignments</Link>
        </div>
      </div>
    );
  }

  const { scenario } = session;

  return (
    <div className="container-wide">
      <div className="card">
        <div className="row">
          <h1>{scenario.title}</h1>
          <Link to="/app" className="btn btn-sm">Back</Link>
        </div>
        <p>{scenario.summary}</p>
        <p className="muted">
          <span className="pill pill-progress">{session.phase === "INVESTIGATING" ? "Investigating" : session.phase}</span>{" "}
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
        disabled={busy || running}
      />

      <TestRunsCard
        session={session}
        running={running}
        canRun={canRunTests(session, busy || running)}
        onRun={() => void onRunTests()}
      />
    </div>
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
        Each save creates a new numbered revision that is never edited afterwards. The server validates the value.
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
