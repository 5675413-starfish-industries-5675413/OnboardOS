import { useCallback, useEffect, useRef, useState } from "react";
import type { CoworkerState, CoworkerTurnView } from "@onboardos/contracts";
import { COWORKER_MAX_MESSAGE_CHARS } from "@onboardos/contracts";
import { fetchCoworker, sendCoworkerMessage } from "../lib/api.js";
import {
  coworkerInputDisabled,
  describeApiError,
  hasPendingTurn,
  keepKeyAfter,
  mergeTurn,
  resolveSendKey,
  validateCoworkerMessage,
  type SendKey,
} from "../lib/views.js";

/** How often a PENDING turn is re-read (for example after a refresh while an answer was in flight). */
const POLL_MS = 3000;

/**
 * The AI coworker: ask questions about the incident and read the persisted conversation.
 *
 * Every answer comes from the server (a real Amazon Bedrock call made by the API); this component never
 * calls a model, never invents a reply and never decides what is allowed. It renders plain text only.
 * The AI is advisory: it cannot run tests, change the configuration, or submit or approve anything.
 */
export function CoworkerPanel(props: { sessionId: string; phase: string; onAuthExpired: (err: unknown) => boolean }) {
  const { sessionId, phase, onAuthExpired } = props;
  const [turns, setTurns] = useState<CoworkerTurnView[]>([]);
  const [state, setState] = useState<CoworkerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCheck, setShowCheck] = useState(false);
  const sendKey = useRef<SendKey | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetchCoworker(sessionId);
      setTurns(r.turns);
      setState(r.coworker);
      setError(null);
    } catch (err) {
      if (!onAuthExpired(err)) setError(describeApiError(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId, onAuthExpired]);

  // Load on mount and whenever the attempt's phase changes (submitting turns the conversation read-only).
  useEffect(() => {
    void load();
  }, [load, phase]);

  const pending = hasPendingTurn(turns);
  useEffect(() => {
    if (!pending || sending) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [pending, sending, load]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length]);

  async function onSend() {
    if (sending || !state?.canSend) return;
    const check = validateCoworkerMessage(draft);
    if (!check.ok) {
      setShowCheck(true);
      return;
    }
    const attempt = resolveSendKey(sendKey.current, check.text, () => crypto.randomUUID());
    sendKey.current = attempt;
    setSending(true);
    setError(null);
    try {
      const r = await sendCoworkerMessage(sessionId, check.text, attempt.key);
      setTurns((cur) => mergeTurn(cur, r.turn));
      setState(r.coworker);
      setDraft("");
      setShowCheck(false);
      sendKey.current = null; // a definitive answer: the next question is a new request
    } catch (err) {
      if (onAuthExpired(err)) return;
      setError(describeApiError(err));
      if (!keepKeyAfter(err)) sendKey.current = null;
      await load(); // always show what the server actually holds
    } finally {
      setSending(false);
    }
  }

  const check = validateCoworkerMessage(draft);
  const enabled = state?.enabled ?? false;
  const inputDisabled = coworkerInputDisabled(state, sending);
  const remaining = COWORKER_MAX_MESSAGE_CHARS - draft.trim().length;

  return (
    <div className="card" data-testid="coworker-panel">
      <div className="row">
        <h2>AI coworker</h2>
        {state?.modelId && <span className="pill" title="The model that writes the answers">{state.modelId}</span>}
      </div>
      <div className="banner banner-warn" role="note">
        <strong>Advisory only.</strong> Answers are written by an AI model and can be wrong. It cannot run tests, change
        your configuration, or submit or approve anything. You do those in this app, and the test results above come
        from real test runs, not from the AI.
      </div>

      {loading && <p role="status">Loading the conversation…</p>}
      {!loading && state && !enabled && (
        <div className="info" role="status" data-testid="coworker-unavailable">
          The AI coworker is not available in this deployment. Nothing has been simulated in its place.
        </div>
      )}

      <div
        ref={logRef}
        className="coworker-log"
        role="log"
        aria-live="polite"
        aria-label="Conversation with the AI coworker"
        data-testid="coworker-log"
      >
        {!loading && turns.length === 0 && enabled && (
          <p className="muted">No questions yet. Ask about the ticket, the runbook, the logs or your test results.</p>
        )}
        {turns.map((t) => (
          <TurnView key={t.turnId} turn={t} />
        ))}
      </div>

      {error && <div className="error" role="alert">{error}</div>}
      {state && !state.canSend && state.reason && enabled && (
        <p className="muted" data-testid="coworker-reason">{state.reason}</p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSend();
        }}
        noValidate
      >
        <label htmlFor="coworker-input">Ask your coworker</label>
        <textarea
          id="coworker-input"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={inputDisabled}
          maxLength={COWORKER_MAX_MESSAGE_CHARS + 200}
          aria-invalid={showCheck && !check.ok ? true : undefined}
          aria-describedby={`coworker-hint${showCheck && !check.ok ? " coworker-error" : ""}`}
        />
        <div id="coworker-hint" className="muted">
          {remaining >= 0 ? `${remaining} characters left` : `${-remaining} characters too many`}
          {state && enabled && ` · ${state.completedTurns} of ${state.limits.maxCompletedTurns} questions used`}
        </div>
        {showCheck && !check.ok && <div id="coworker-error" className="field-error" role="alert">{check.message}</div>}
        <div style={{ marginTop: ".6rem" }}>
          <button className="btn" type="submit" disabled={inputDisabled}>
            {sending ? "Waiting for the AI coworker…" : "Ask"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function TurnView({ turn }: { turn: CoworkerTurnView }) {
  return (
    <div className="coworker-turn" data-testid="coworker-turn">
      <div className="coworker-you">
        <span className="muted">You</span>
        <div className="prewrap">{turn.userText}</div>
      </div>
      <div className="coworker-ai">
        <span className="muted">AI coworker · {turn.modelId}</span>
        {turn.status === "PENDING" && <div role="status">Thinking… this can take a few seconds.</div>}
        {turn.status === "COMPLETE" && (
          <>
            <div className="prewrap">{turn.reply}</div>
            {turn.truncated && <div className="muted">The answer was cut short because it reached its length limit.</div>}
          </>
        )}
        {turn.status === "ERROR" && (
          <div className="error" role="alert" style={{ marginBottom: 0 }}>
            {turn.errorMessage ?? "The AI coworker could not answer."} No answer was recorded.
          </div>
        )}
      </div>
    </div>
  );
}
