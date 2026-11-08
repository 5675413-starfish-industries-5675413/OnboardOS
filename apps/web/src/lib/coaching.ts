/**
 * Pure logic of the manager Coaching Studio screen, kept out of React so it is unit tested.
 *
 * NOTHING here grants anything or validates authoritatively: the server validates every save and publish. These
 * helpers only manage the editing state: dirty tracking, list editing, and how a failed call is presented.
 */

import type {
  CoachingDraftContent,
  CoachingDraftView,
  CoachingStudioResponse,
  CoachingVersionDetail,
  CoachingVersionSummary,
  ValidateCoachingResponse,
} from "@onboardos/contracts";
import { COACHING_LIMITS, COACHING_NOTES_ENABLED } from "@onboardos/contracts";
import { ApiError } from "./api.js";

export const cloneContent = (c: CoachingDraftContent): CoachingDraftContent => JSON.parse(JSON.stringify(c)) as CoachingDraftContent;
export const sameContent = (a: CoachingDraftContent, b: CoachingDraftContent): boolean => JSON.stringify(a) === JSON.stringify(b);

// -- list editing ---------------------------------------------------------------------------------------------

export function replaceAt<T>(list: readonly T[], i: number, value: T): T[] {
  return list.map((x, j) => (j === i ? value : x));
}
export function removeAt<T>(list: readonly T[], i: number): T[] {
  return list.filter((_, j) => j !== i);
}
/** Move an item up (-1) or down (+1). Out-of-range moves return the list unchanged. */
export function moveItem<T>(list: readonly T[], i: number, delta: -1 | 1): T[] {
  const j = i + delta;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[i], out[j]] = [out[j] as T, out[i] as T];
  return out;
}
/** Append only while the list is under its limit. */
export function addItem<T>(list: readonly T[], item: T, max: number): T[] {
  return list.length >= max ? [...list] : [...list, item];
}

// -- state --------------------------------------------------------------------------------------------------------

export interface StudioState {
  phase: "loading" | "ready" | "error";
  loadError: string | null;
  data: CoachingStudioResponse | null;
  /** The working copy being edited. */
  form: CoachingDraftContent | null;
  /** What the working copy was last loaded from or saved as (the saved draft, or the template before any save). */
  baseline: CoachingDraftContent | null;
  /** The revision the baseline corresponds to (0 = no draft saved yet). */
  baselineRevision: number;
  saving: boolean;
  validating: boolean;
  publishing: boolean;
  notice: string | null;
  error: string | null;
  /** Another editor saved or published first. The editor must reload before anything else. */
  conflict: boolean;
  validation: ValidateCoachingResponse | null;
  /** A published version opened for inspection. Read-only. */
  viewing: CoachingVersionDetail | null;
}

export const initialState: StudioState = {
  phase: "loading", loadError: null, data: null, form: null, baseline: null, baselineRevision: 0,
  saving: false, validating: false, publishing: false, notice: null, error: null, conflict: false, validation: null, viewing: null,
};

export type Action =
  | { type: "loaded"; data: CoachingStudioResponse }
  | { type: "loadFailed"; message: string }
  | { type: "edit"; form: CoachingDraftContent }
  | { type: "saveStarted" }
  | { type: "saved"; draft: CoachingDraftView }
  | { type: "validateStarted" }
  | { type: "validated"; result: ValidateCoachingResponse }
  | { type: "validateAbandoned" }
  | { type: "publishStarted" }
  | { type: "published"; version: CoachingVersionSummary; refreshed: CoachingStudioResponse }
  | { type: "failed"; message: string; conflict: boolean }
  | { type: "view"; version: CoachingVersionDetail }
  | { type: "closeView" }
  | { type: "reload" };

export function reducer(s: StudioState, a: Action): StudioState {
  switch (a.type) {
    case "reload":
      return { ...initialState };
    case "loaded": {
      const start = a.data.draft?.content ?? a.data.template;
      return { ...initialState, phase: "ready", data: a.data, form: cloneContent(start), baseline: cloneContent(start), baselineRevision: a.data.draft?.revision ?? 0 };
    }
    case "loadFailed":
      return { ...s, phase: "error", loadError: a.message };
    case "edit":
      // Nothing may change the text while a request about it is in flight, or after a conflict (reload first).
      if (s.saving || s.validating || s.publishing || s.conflict) return s;
      // Editing clears stale feedback: an old validation result no longer describes this text.
      return { ...s, form: a.form, notice: null, error: null, validation: null };
    case "saveStarted":
      return { ...s, saving: true, error: null, notice: null };
    case "saved": {
      const data = s.data ? { ...s.data, draft: a.draft } : s.data;
      return { ...s, saving: false, data, baseline: cloneContent(a.draft.content), baselineRevision: a.draft.revision, notice: `Draft saved (revision ${a.draft.revision}).`, conflict: false };
    }
    case "validateStarted":
      return { ...s, validating: true, error: null };
    case "validated":
      return { ...s, validating: false, validation: a.result };
    case "validateAbandoned":
      return { ...s, validating: false };
    case "publishStarted":
      return { ...s, publishing: true, error: null, notice: null };
    case "published": {
      const start = a.refreshed.draft?.content ?? a.refreshed.template;
      return {
        ...s, publishing: false, data: a.refreshed, form: cloneContent(start), baseline: cloneContent(start), baselineRevision: a.refreshed.draft?.revision ?? 0,
        notice: `Published version ${a.version.profileVersion}. New assignments of this scenario will use it; existing assignments keep the version they were created with.`, conflict: false,
      };
    }
    case "failed":
      return { ...s, saving: false, validating: false, publishing: false, error: a.message, conflict: a.conflict || s.conflict };
    case "view":
      return { ...s, viewing: a.version };
    case "closeView":
      return { ...s, viewing: null };
  }
}

// -- derived ----------------------------------------------------------------------------------------------------------

export const isDirty = (s: StudioState): boolean => !!s.form && !!s.baseline && !sameContent(s.form, s.baseline);

export interface Derived {
  dirty: boolean;
  busy: boolean;
  canSave: boolean;
  canPublish: boolean;
  /** Why publishing is unavailable right now, in plain words. */
  publishBlockedReason: string | null;
  hasUnpublishedChanges: boolean;
  /** What a NEW assignment would receive. */
  newAssignmentsUse: string;
}

export function derive(s: StudioState): Derived {
  const dirty = isDirty(s);
  const busy = s.saving || s.validating || s.publishing;
  const draft = s.data?.draft ?? null;
  const published = s.data?.currentProfileVersion ?? null;
  const hasUnpublishedChanges = !!draft && draft.revision > draft.publishedThroughRevision;
  // Notes cannot be saved or published while they are unavailable: say so instead of letting the server refuse silently.
  const notesBlocked = !COACHING_NOTES_ENABLED && (s.form?.coaching.notes.length ?? 0) > 0;
  let reason: string | null = null;
  if (notesBlocked) reason = "Remove the coaching notes first: free-text notes are temporarily unavailable.";
  else if (s.conflict) reason = "Reload first: someone else changed this configuration.";
  else if (busy) reason = "Please wait for the current action to finish.";
  else if (dirty) reason = "Save your changes before publishing.";
  else if (!draft) reason = "Save a draft before publishing.";
  else if (!hasUnpublishedChanges) reason = "This draft is already published.";
  return {
    dirty, busy,
    canSave: !!s.form && dirty && !busy && !s.conflict && !notesBlocked,
    canPublish: reason === null,
    publishBlockedReason: reason,
    hasUnpublishedChanges,
    newAssignmentsUse: published ? `your published coaching version ${published}` : "the platform's built-in coaching (you have not published a version yet)",
  };
}

/** How a failed call is shown. Conflicts are flagged so the editor locks until reloaded. */
export function describeStudioError(err: unknown): { message: string; conflict: boolean } {
  if (!(err instanceof ApiError)) return { message: "Something went wrong. Please try again.", conflict: false };
  if (err.status === 409 && (err.code === "REVISION_CONFLICT" || err.code === "VERSION_CONFLICT")) {
    return { message: "Someone else changed this configuration while you were editing. Reload to see their changes; your unsaved edits on this page will be replaced.", conflict: true };
  }
  switch (err.status) {
    case 0: return { message: "Could not reach the server. Your edits are still on this page; try again.", conflict: false };
    case 401: return { message: "Your session has expired. Please sign in again.", conflict: false };
    case 403: return { message: "You do not have permission to manage coaching.", conflict: false };
    case 404: return { message: "That scenario was not found, or you do not have access to it.", conflict: false };
    case 409: return { message: err.code === "NO_DRAFT" ? "There is no saved draft to publish. Save a draft first." : "That could not be completed because something changed. Reload and try again.", conflict: false };
    case 422: return { message: err.message || "The coaching configuration was rejected.", conflict: false };
    default: return { message: "The server could not complete the request. Please try again.", conflict: false };
  }
}

export const LIMITS = COACHING_LIMITS;

/** Show validation errors next to the field they belong to. */
export function errorsFor(v: ValidateCoachingResponse | null, path: string): string[] {
  return v ? v.errors.filter((e) => e.path === path).map((e) => e.message) : [];
}

/** What an assignment's coaching column says. Existing assignments never change this after creation. */
export function assignmentCoachingLabel(c: { source: "ORG_PUBLISHED" | "BUILT_IN"; profileVersion: number | null } | undefined): string {
  if (!c) return "—";
  return c.source === "ORG_PUBLISHED" && c.profileVersion !== null ? `Your version ${c.profileVersion}` : "Platform built-in";
}

/** One line for the assignment card: what a NEW assignment of this scenario will receive. */
export function newAssignmentCoachingLine(currentProfileVersion: number | null | undefined): string {
  // undefined means "not known" (still loading, or the lookup failed): never guess that it is the built-in coaching.
  if (currentProfileVersion === undefined) return "AI coaching for new assignments: not available right now.";
  return currentProfileVersion ? `AI coaching for new assignments: your published version ${currentProfileVersion}.` : "AI coaching for new assignments: the platform's built-in coaching (you have not published a version).";
}
