import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { SessionView } from "@onboardos/contracts";
import { ApiError, fetchSession, postSessionAction } from "../lib/api.js";
import { actionForTab, describeApiError, type Tab } from "../lib/views.js";

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

      <div className="card">
        <h2>Current configuration</h2>
        <p className="mono" data-testid="config">
          {JSON.stringify(session.config)}
        </p>
        <p className="muted">Read-only for now.</p>
      </div>
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
