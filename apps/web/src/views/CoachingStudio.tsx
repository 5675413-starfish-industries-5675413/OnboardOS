import { useEffect, useMemo, useReducer, useRef } from "react";
import type { CoachingDraftContent, CoachingVersionDetail } from "@onboardos/contracts";
import { COACHING_LIMITS, COACHING_TEXT_MAX } from "@onboardos/contracts";
import { getCoachingStudio, getCoachingVersion, publishCoaching, saveCoachingDraft, validateCoaching } from "../lib/api.js";
import { createController } from "../lib/studioController.js";
import {
  addItem,
  derive,
  errorsFor,
  initialState,
  moveItem,
  reducer,
  removeAt,
  replaceAt,
  type StudioState,
} from "../lib/coaching.js";

/**
 * Manager Coaching Studio: configure how the AI coworker helps with a supported scenario, save a draft, validate,
 * and publish an immutable version.
 *
 * Everything entered here is EMPLOYEE-VISIBLE coaching. Hidden tests, thresholds, answer keys and private grading are
 * not configured here and must not be typed here. The server validates every save and publish; this screen only
 * edits and displays. No AI model is called by anything on this screen.
 */

const ASSISTANCE = { explain_only: "Explain only", guide: "Guide with hints and questions", collaborate: "Collaborate on next steps" } as const;
const HINTS = { questions_first: "Questions first", gradual: "Gradually more specific", direct_when_asked: "Direct when asked" } as const;
const TONES = { friendly: "Friendly", neutral: "Neutral", formal: "Formal" } as const;
const OFF_TOPIC = { redirect: "Redirect to the task", brief_help_then_redirect: "Brief help, then redirect" } as const;
const UNCERTAINTY = { name_unknowns: "Say what is not known", ask_first: "Ask a clarifying question first" } as const;
const LEVELS = { entry: "Entry", intermediate: "Intermediate", advanced: "Advanced" } as const;

export interface Handlers {
  edit: (form: CoachingDraftContent) => void;
  save: () => void;
  validate: () => void;
  publish: () => void;
  reload: () => void;
  view: (profileVersion: number) => void;
  closeView: () => void;
}

// -- small pieces ---------------------------------------------------------------------------------------------

/** Field-level problems. `id` lets the input point at them with aria-describedby. */
function FieldErrors({ messages, id }: { messages: string[]; id?: string }) {
  if (messages.length === 0) return null;
  return <div className="error" role="alert" id={id}>{messages.join(" ")}</div>;
}

/** aria attributes for an input whose problems are shown by FieldErrors with the same id. */
const aria = (messages: string[], id: string) => (messages.length ? { "aria-invalid": true as const, "aria-describedby": id } : {});

interface ListProps {
  id: string;
  label: string;
  help?: string;
  items: string[];
  max: number;
  maxChars: number;
  disabled: boolean;
  validation: StudioState["validation"];
  onChange: (items: string[]) => void;
  addLabel: string;
}

/** An ordered list of short texts: add, edit, remove, reorder. */
export function StringList({ id, label, help, items, max, maxChars, disabled, validation, onChange, addLabel }: ListProps) {
  return (
    <fieldset>
      <legend>{label}</legend>
      {help && <p className="muted">{help}</p>}
      {items.length === 0 && <p className="muted">None yet.</p>}
      <ol style={{ paddingLeft: "1.25rem" }}>
        {items.map((text, i) => (
          <li key={i} style={{ marginBottom: ".5rem" }}>
            <label htmlFor={`${id}-${i}`} className="sr-only">{`${label} ${i + 1}`}</label>
            <textarea
              id={`${id}-${i}`}
              rows={2}
              maxLength={maxChars}
              value={text}
              disabled={disabled}
              onChange={(e) => onChange(replaceAt(items, i, e.target.value))}
              style={{ width: "100%" }}
              {...aria(errorsFor(validation, `${id}[${i}]`), `${id}-${i}-err`)}
            />
            <div className="row">
              <span className="muted">{text.length}/{maxChars}</span>
              <span>
                <button type="button" className="btn btn-sm" disabled={disabled || i === 0} onClick={() => onChange(moveItem(items, i, -1))} aria-label={`Move ${label} ${i + 1} up`}>Up</button>{" "}
                <button type="button" className="btn btn-sm" disabled={disabled || i === items.length - 1} onClick={() => onChange(moveItem(items, i, 1))} aria-label={`Move ${label} ${i + 1} down`}>Down</button>{" "}
                <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => onChange(removeAt(items, i))} aria-label={`Remove ${label} ${i + 1}`}>Remove</button>
              </span>
            </div>
            <FieldErrors messages={errorsFor(validation, `${id}[${i}]`)} id={`${id}-${i}-err`} />
          </li>
        ))}
      </ol>
      <button type="button" className="btn btn-sm" disabled={disabled || items.length >= max} onClick={() => onChange(addItem(items, "", max))}>
        {addLabel}
      </button>{" "}
      <span className="muted">{items.length}/{max}</span>
    </fieldset>
  );
}

function Select<T extends string>({ id, label, value, options, disabled, onChange }: { id: string; label: string; value: T; options: Record<T, string>; disabled: boolean; onChange: (v: T) => void }) {
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {(Object.keys(options) as T[]).map((k) => <option key={k} value={k}>{options[k]}</option>)}
      </select>
    </div>
  );
}

// -- the screen ---------------------------------------------------------------------------------------------------

/** Presentational and pure: everything it shows comes from `state`. */
export function StudioView({ state, on }: { state: StudioState; on: Handlers }) {
  if (state.phase === "loading") return <div className="card"><p role="status">Loading AI coworker settings…</p></div>;
  if (state.phase === "error" || !state.data || !state.form) {
    return (
      <div className="card">
        <h2>AI coworker settings</h2>
        <div className="error" role="alert">{state.loadError ?? "These settings could not be loaded."}</div>
        <button className="btn btn-sm" onClick={on.reload}>Try again</button>
      </div>
    );
  }

  const d = derive(state);
  const f = state.form;
  const data = state.data;
  const off = d.busy || state.conflict;
  const set = (patch: Partial<CoachingDraftContent>) => on.edit({ ...f, ...patch });

  return (
    <>
      {state.conflict && (
        <div className="error" role="alert" data-testid="conflict">
          <strong>This configuration changed while you were editing.</strong>{" "}
          Someone else saved or published first. Reload to see their changes; your unsaved edits on this page will be replaced.{" "}
          <button className="btn btn-sm" onClick={on.reload}>Reload</button>
        </div>
      )}
      {state.error && !state.conflict && <div className="error" role="alert">{state.error}</div>}
      {state.notice && <div className="info" role="status">{state.notice}</div>}

      <div className="card">
        <h2>{data.scenario.title}</h2>
        <dl>
          <dt className="label">Associated role</dt><dd className="value">{data.scenario.targetRole ?? "Not specified"}</dd>
          <dt className="label">Scenario version</dt><dd className="value">{data.scenario.scenarioVersion}</dd>
          <dt className="label">Current published coaching version</dt>
          <dd className="value">{data.currentProfileVersion ? `Version ${data.currentProfileVersion}` : "None published"}</dd>
          <dt className="label">New assignments will use</dt><dd className="value">{d.newAssignmentsUse}</dd>
        </dl>
        <p className="muted">
          Employees assigned before you publish keep the coaching they were created with. Everything you write here is visible to the
          employee and can be quoted by the AI coworker. Do not enter grading details, thresholds or answers.
        </p>
        <div className="row">
          <span>{d.dirty ? <strong>Unsaved changes</strong> : data.draft ? `Draft saved (revision ${data.draft.revision})` : "No draft saved yet (starting from the platform's template)"}</span>
          {d.dirty && <span className="muted" data-testid="unsaved">You will lose these edits if you leave this page.</span>}
        </div>
      </div>

      <div className="card">
        <h2>Audience</h2>
        <div className="toolbar">
          <div>
            <label htmlFor="role">Target role</label>
            <input id="role" type="text" maxLength={COACHING_TEXT_MAX.targetRole} value={f.audience.targetRole} disabled={off} onChange={(e) => set({ audience: { ...f.audience, targetRole: e.target.value } })} {...aria(errorsFor(state.validation, "audience.targetRole"), "role-err")} />
            <FieldErrors messages={errorsFor(state.validation, "audience.targetRole")} id="role-err" />
          </div>
          <div>
            <label htmlFor="domain">Field or domain</label>
            <input id="domain" type="text" maxLength={COACHING_TEXT_MAX.domain} value={f.audience.domain} disabled={off} onChange={(e) => set({ audience: { ...f.audience, domain: e.target.value } })} {...aria(errorsFor(state.validation, "audience.domain"), "domain-err")} />
            <FieldErrors messages={errorsFor(state.validation, "audience.domain")} id="domain-err" />
          </div>
          <Select id="level" label="Experience level" value={f.audience.experienceLevel} options={LEVELS} disabled={off} onChange={(v) => set({ audience: { ...f.audience, experienceLevel: v } })} />
        </div>
      </div>

      <div className="card">
        <h2>Learning objectives</h2>
        <StringList id="learningObjectives" label="Learning objective" help="What the employee should learn from this scenario." items={f.learningObjectives} max={COACHING_LIMITS.maxObjectives} maxChars={COACHING_TEXT_MAX.item} disabled={off} validation={state.validation} onChange={(learningObjectives) => set({ learningObjectives })} addLabel="Add objective" />
      </div>

      <div className="card">
        <h2>Public success criteria</h2>
        <StringList id="successCriteria" label="Success criterion" help="What the employee is told success looks like. This is shown to the employee: it is not the private grading." items={f.successCriteria} max={COACHING_LIMITS.maxCriteria} maxChars={COACHING_TEXT_MAX.item} disabled={off} validation={state.validation} onChange={(successCriteria) => set({ successCriteria })} addLabel="Add criterion" />
      </div>

      <div className="card">
        <h2>AI coaching behavior</h2>
        <div className="toolbar">
          <Select id="assistance" label="Assistance level" value={f.coaching.assistance} options={ASSISTANCE} disabled={off} onChange={(v) => set({ coaching: { ...f.coaching, assistance: v } })} />
          <Select id="hints" label="Hint progression" value={f.coaching.hintProgression} options={HINTS} disabled={off} onChange={(v) => set({ coaching: { ...f.coaching, hintProgression: v } })} />
          <Select id="tone" label="Communication tone" value={f.coaching.tone} options={TONES} disabled={off} onChange={(v) => set({ coaching: { ...f.coaching, tone: v } })} />
          <Select id="offtopic" label="Off-topic requests" value={f.coaching.offTopic} options={OFF_TOPIC} disabled={off} onChange={(v) => set({ coaching: { ...f.coaching, offTopic: v } })} />
          <Select id="uncertainty" label="When unsure" value={f.coaching.uncertainty} options={UNCERTAINTY} disabled={off} onChange={(v) => set({ coaching: { ...f.coaching, uncertainty: v } })} />
          <div>
            <label htmlFor="words">Preferred answer length (words)</label>
            <input id="words" type="number" min={COACHING_LIMITS.minWords} max={COACHING_LIMITS.maxWords} value={f.coaching.maxWords} disabled={off} onChange={(e) => set({ coaching: { ...f.coaching, maxWords: Number.parseInt(e.target.value, 10) || 0 } })} {...aria(errorsFor(state.validation, "coaching.maxWords"), "words-err")} aria-describedby={errorsFor(state.validation, "coaching.maxWords").length ? "words-err" : "words-help"} />
            <div className="muted" id="words-help">{COACHING_LIMITS.minWords} to {COACHING_LIMITS.maxWords}. A preference given to the model, not a guaranteed limit.</div>
            <FieldErrors messages={errorsFor(state.validation, "coaching.maxWords")} id="words-err" />
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Manager coaching notes</h2>
        <StringList id="coaching.notes" label="Coaching note" help="Short preferences about how to teach. They are subordinate to the platform's rules and cannot give the coworker new abilities, remove its limits, or change grading." items={f.coaching.notes} max={COACHING_LIMITS.maxNotes} maxChars={COACHING_TEXT_MAX.item} disabled={off} validation={state.validation} onChange={(notes) => set({ coaching: { ...f.coaching, notes } })} addLabel="Add note" />
      </div>

      <div className="card">
        <h2>Supporting context</h2>
        <fieldset>
          <legend>Terminology</legend>
          {f.terminology.length === 0 && <p className="muted">None yet.</p>}
          {f.terminology.map((t, i) => (
            <div key={i} className="toolbar">
              <div>
                <label htmlFor={`term-${i}`}>{`Term ${i + 1}`}</label>
                <input id={`term-${i}`} type="text" maxLength={COACHING_TEXT_MAX.term} value={t.term} disabled={off} onChange={(e) => set({ terminology: replaceAt(f.terminology, i, { ...t, term: e.target.value }) })} />
                <FieldErrors messages={errorsFor(state.validation, `terminology[${i}].term`)} />
              </div>
              <div style={{ flex: 1 }}>
                <label htmlFor={`meaning-${i}`}>{`Meaning ${i + 1}`}</label>
                <input id={`meaning-${i}`} type="text" maxLength={COACHING_TEXT_MAX.meaning} value={t.meaning} disabled={off} onChange={(e) => set({ terminology: replaceAt(f.terminology, i, { ...t, meaning: e.target.value }) })} style={{ width: "100%" }} />
                <FieldErrors messages={errorsFor(state.validation, `terminology[${i}].meaning`)} />
              </div>
              <button type="button" className="btn btn-sm" disabled={off} onClick={() => set({ terminology: removeAt(f.terminology, i) })} aria-label={`Remove term ${i + 1}`}>Remove</button>
            </div>
          ))}
          <button type="button" className="btn btn-sm" disabled={off || f.terminology.length >= COACHING_LIMITS.maxTerms} onClick={() => set({ terminology: addItem(f.terminology, { term: "", meaning: "" }, COACHING_LIMITS.maxTerms) })}>Add term</button>{" "}
          <span className="muted">{f.terminology.length}/{COACHING_LIMITS.maxTerms}</span>
        </fieldset>

        <StringList id="constraints" label="Operational constraint" help="Rules the employee must respect, such as policy limits." items={f.constraints} max={COACHING_LIMITS.maxConstraints} maxChars={COACHING_TEXT_MAX.item} disabled={off} validation={state.validation} onChange={(constraints) => set({ constraints })} addLabel="Add constraint" />

        <fieldset>
          <legend>Public reference material</legend>
          {f.reference.length === 0 && <p className="muted">None yet.</p>}
          {f.reference.map((r, i) => (
            <div key={i} style={{ marginBottom: ".75rem" }}>
              <label htmlFor={`ref-title-${i}`}>{`Reference ${i + 1} title`}</label>
              <input id={`ref-title-${i}`} type="text" maxLength={COACHING_TEXT_MAX.referenceTitle} value={r.title} disabled={off} onChange={(e) => set({ reference: replaceAt(f.reference, i, { ...r, title: e.target.value }) })} />
              <FieldErrors messages={errorsFor(state.validation, `reference[${i}].title`)} />
              <label htmlFor={`ref-body-${i}`}>{`Reference ${i + 1} text`}</label>
              <textarea id={`ref-body-${i}`} rows={4} maxLength={COACHING_TEXT_MAX.referenceBody} value={r.body} disabled={off} onChange={(e) => set({ reference: replaceAt(f.reference, i, { ...r, body: e.target.value }) })} style={{ width: "100%" }} />
              <FieldErrors messages={errorsFor(state.validation, `reference[${i}].body`)} />
              <button type="button" className="btn btn-sm" disabled={off} onClick={() => set({ reference: removeAt(f.reference, i) })} aria-label={`Remove reference ${i + 1}`}>Remove</button>
            </div>
          ))}
          <button type="button" className="btn btn-sm" disabled={off || f.reference.length >= COACHING_LIMITS.maxReferences} onClick={() => set({ reference: addItem(f.reference, { title: "", body: "" }, COACHING_LIMITS.maxReferences) })}>Add reference</button>{" "}
          <span className="muted">{f.reference.length}/{COACHING_LIMITS.maxReferences}</span>
        </fieldset>
      </div>

      <div className="card">
        <h2>Validate and preview</h2>
        <p className="muted">Checks the current text (saved or not) and shows the instructions it selects. No AI model is called or tested.</p>
        <button className="btn" disabled={off} onClick={on.validate}>{state.validating ? "Validating…" : "Validate and preview"}</button>
        {state.validation && (
          <div data-testid="validation" style={{ marginTop: ".75rem" }}>
            {state.validation.valid ? (
              <div className="info" role="status">Valid. This configuration can be published.</div>
            ) : (
              <div className="error" role="alert">
                {state.validation.errors.length} problem{state.validation.errors.length === 1 ? "" : "s"} to fix before publishing:
                <ul>{state.validation.errors.map((e, i) => <li key={i}><code>{e.path || "profile"}</code>: {e.message}</li>)}</ul>
              </div>
            )}
            <h3>Effective AI coworker behavior</h3>
            <ul>{state.validation.effective.map((line, i) => <li key={i}>{line}</li>)}</ul>
            <p className="muted">{state.validation.notice}</p>
          </div>
        )}
        <p className="muted">
          Private assessment (hidden tests, thresholds, grading) is not configurable here. It is a separate, future capability, and nothing on this
          screen changes how work is evaluated.
        </p>
      </div>

      <div className="card">
        <h2>Save and publish</h2>
        <div className="toolbar">
          <button className="btn" disabled={!d.canSave} onClick={on.save}>{state.saving ? "Saving…" : "Save draft"}</button>
          <button className="btn" disabled={!d.canPublish} onClick={on.publish}>{state.publishing ? "Publishing…" : "Publish new version"}</button>
        </div>
        {d.publishBlockedReason && <p className="muted" data-testid="publish-blocked">{d.publishBlockedReason}</p>}
        <p className="muted">Publishing creates a new immutable version. It cannot be edited afterwards; make changes in the draft and publish again.</p>

        <h3>Published versions</h3>
        {data.versions.length === 0 ? (
          <p className="muted">Nothing published yet.</p>
        ) : (
          <table className="data">
            <caption className="sr-only">Published coaching versions, newest first</caption>
            <thead><tr><th scope="col">Version</th><th scope="col">Published</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Inspect</span></th></tr></thead>
            <tbody>
              {data.versions.map((v) => (
                <tr key={v.profileVersion}>
                  <td>Version {v.profileVersion}</td>
                  <td className="muted">{new Date(v.publishedAt).toLocaleString()}</td>
                  <td>{v.isCurrent ? "Current: used by new assignments" : "Earlier version"}</td>
                  <td><button className="btn btn-sm" onClick={() => on.view(v.profileVersion)}>View</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {state.viewing && <VersionReadOnly v={state.viewing} onClose={on.closeView} />}
    </>
  );
}

/** A published version, shown read-only. There are no inputs, so it cannot be edited. */
export function VersionReadOnly({ v, onClose }: { v: CoachingVersionDetail; onClose: () => void }) {
  const c = v.content;
  return (
    <div className="card" data-testid="version-readonly">
      <div className="row">
        <h2>Published version {v.profileVersion} (read only)</h2>
        <button className="btn btn-sm" onClick={onClose}>Close</button>
      </div>
      <p className="muted">Published {new Date(v.publishedAt).toLocaleString()}. Published versions cannot be changed.</p>
      <dl>
        <dt className="label">Target role</dt><dd>{c.audience.targetRole}</dd>
        <dt className="label">Field</dt><dd>{c.audience.domain}</dd>
        <dt className="label">Experience level</dt><dd>{LEVELS[c.audience.experienceLevel]}</dd>
        <dt className="label">Assistance</dt><dd>{ASSISTANCE[c.coaching.assistance]}</dd>
        <dt className="label">Hints</dt><dd>{HINTS[c.coaching.hintProgression]}</dd>
        <dt className="label">Tone</dt><dd>{TONES[c.coaching.tone]}</dd>
        <dt className="label">Off-topic</dt><dd>{OFF_TOPIC[c.coaching.offTopic]}</dd>
        <dt className="label">When unsure</dt><dd>{UNCERTAINTY[c.coaching.uncertainty]}</dd>
        <dt className="label">Answer length</dt><dd>about {c.coaching.maxWords} words</dd>
      </dl>
      <h3>Learning objectives</h3>
      <ol>{c.learningObjectives.map((t, i) => <li key={i}>{t}</li>)}</ol>
      <h3>Public success criteria</h3>
      <ol>{c.successCriteria.map((t, i) => <li key={i}>{t}</li>)}</ol>
      <h3>Coaching notes</h3>
      {c.coaching.notes.length === 0 ? <p className="muted">None.</p> : <ul>{c.coaching.notes.map((t, i) => <li key={i}>{t}</li>)}</ul>}
      <h3>Terminology</h3>
      {c.terminology.length === 0 ? <p className="muted">None.</p> : <ul>{c.terminology.map((t, i) => <li key={i}><strong>{t.term}</strong>: {t.meaning}</li>)}</ul>}
      <h3>Constraints</h3>
      {c.constraints.length === 0 ? <p className="muted">None.</p> : <ul>{c.constraints.map((t, i) => <li key={i}>{t}</li>)}</ul>}
      <h3>Reference material</h3>
      {c.reference.length === 0 ? <p className="muted">None.</p> : c.reference.map((r, i) => <div key={i}><strong>{r.title}</strong><p>{r.body}</p></div>)}
    </div>
  );
}

// -- container --------------------------------------------------------------------------------------------------------

export function CoachingStudio({ orgId, scenarioId, onDirtyChange }: { orgId: string; scenarioId: string; onDirtyChange?: (dirty: boolean) => void }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // One controller per organization+scenario. Leaving the page (or changing scenario) disposes it, so a response that
  // arrives later is dropped instead of updating a screen that is no longer there.
  const controller = useMemo(
    () =>
      createController({
        dispatch,
        getState: () => stateRef.current,
        confirm: (m) => window.confirm(m),
        api: {
          get: () => getCoachingStudio(orgId, scenarioId),
          save: (rev, content) => saveCoachingDraft(orgId, scenarioId, rev, content),
          validate: (content) => validateCoaching(orgId, scenarioId, content),
          publish: (rev, current) => publishCoaching(orgId, scenarioId, rev, current),
          version: (v) => getCoachingVersion(orgId, scenarioId, v),
        },
      }),
    [orgId, scenarioId],
  );
  useEffect(() => {
    void controller.load();
    return () => controller.dispose();
  }, [controller]);

  const d = derive(state);
  // Tell the page, so its own navigation can warn too; and warn before the tab is closed or reloaded.
  useEffect(() => { onDirtyChange?.(d.dirty); }, [d.dirty, onDirtyChange]);
  useEffect(() => {
    if (!d.dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [d.dirty]);

  const on: Handlers = {
    edit: (form) => dispatch({ type: "edit", form }),
    reload: () => void controller.reload(),
    closeView: () => dispatch({ type: "closeView" }),
    save: () => void controller.save(),
    validate: () => void controller.validate(),
    publish: () => void controller.publish(),
    view: (v) => void controller.view(v),
  };

  return <StudioView state={state} on={on} />;
}
