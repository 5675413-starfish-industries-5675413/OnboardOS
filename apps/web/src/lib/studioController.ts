/**
 * The asynchronous side of the Coaching Studio screen, as plain functions so it can be tested without a browser.
 *
 * Its one job beyond calling the API is to make sure an OLD response can never overwrite NEWER state:
 *  - every operation remembers the "generation" it started in; reloading (or leaving the page) bumps the generation, and a
 *    response from an older generation is dropped;
 *  - only one write/validate/publish runs at a time (the screen also disables its controls, but this does not rely on it);
 *  - a validation result is shown only if the text it validated is still the text on screen.
 * Nothing here is a security control: the server validates and authorizes everything.
 */

import type {
  CoachingDraftContent,
  CoachingStudioResponse,
  CoachingVersionDetail,
  PublishCoachingResponse,
  SaveCoachingDraftResponse,
  ValidateCoachingResponse,
} from "@onboardos/contracts";
import { derive, describeStudioError, isDirty, sameContent, type Action, type StudioState } from "./coaching.js";

export interface StudioApi {
  get(): Promise<CoachingStudioResponse>;
  save(expectedRevision: number, content: CoachingDraftContent): Promise<SaveCoachingDraftResponse>;
  validate(content: CoachingDraftContent): Promise<ValidateCoachingResponse>;
  publish(draftRevision: number, expectedCurrentVersion: number): Promise<PublishCoachingResponse>;
  version(profileVersion: number): Promise<CoachingVersionDetail>;
}

export interface ControllerOptions {
  api: StudioApi;
  dispatch: (a: Action) => void;
  /** The CURRENT state, read at call time (not captured). */
  getState: () => StudioState;
  confirm: (message: string) => boolean;
}

export const PUBLISH_CONFIRMATION =
  "Publish a new immutable coaching version? New assignments will use it. Existing assignments keep their current coaching.";

export function createController(o: ControllerOptions) {
  let generation = 0;
  let disposed = false;
  const live = (g: number): boolean => !disposed && g === generation;
  const busy = (s: StudioState): boolean => s.saving || s.validating || s.publishing;
  const fail = (g: number, err: unknown): void => {
    if (live(g)) o.dispatch({ type: "failed", ...describeStudioError(err) });
  };

  async function load(): Promise<void> {
    const g = generation;
    try {
      const data = await o.api.get();
      if (live(g)) o.dispatch({ type: "loaded", data });
    } catch (err) {
      if (live(g)) o.dispatch({ type: "loadFailed", message: describeStudioError(err).message });
    }
  }

  return {
    load,
    /** Discard everything in flight and load again. */
    reload(): Promise<void> {
      generation++;
      o.dispatch({ type: "reload" });
      return load();
    },
    dispose(): void {
      disposed = true;
    },
    async save(): Promise<void> {
      const s = o.getState();
      if (!s.form || busy(s) || s.conflict || !isDirty(s)) return;
      const g = generation;
      const form = s.form;
      o.dispatch({ type: "saveStarted" });
      try {
        const r = await o.api.save(s.baselineRevision, form);
        if (live(g)) o.dispatch({ type: "saved", draft: r.draft });
      } catch (err) {
        fail(g, err);
      }
    },
    async validate(): Promise<void> {
      const s = o.getState();
      if (!s.form || busy(s) || s.conflict) return;
      const g = generation;
      const form = s.form;
      o.dispatch({ type: "validateStarted" });
      try {
        const result = await o.api.validate(form);
        // Show it only if it still describes what is on screen.
        if (live(g) && o.getState().form && sameContent(o.getState().form as CoachingDraftContent, form)) o.dispatch({ type: "validated", result });
        else if (live(g)) o.dispatch({ type: "validateAbandoned" });
      } catch (err) {
        fail(g, err);
      }
    },
    async publish(): Promise<void> {
      const s = o.getState();
      const draft = s.data?.draft;
      if (!draft || !derive(s).canPublish) return;
      if (!o.confirm(PUBLISH_CONFIRMATION)) return;
      const g = generation;
      o.dispatch({ type: "publishStarted" });
      try {
        const r = await o.api.publish(draft.revision, s.data?.currentProfileVersion ?? 0);
        const refreshed = await o.api.get();
        if (live(g)) o.dispatch({ type: "published", version: r.version, refreshed });
      } catch (err) {
        fail(g, err);
      }
    },
    async view(profileVersion: number): Promise<void> {
      const g = generation;
      try {
        const version = await o.api.version(profileVersion);
        if (live(g)) o.dispatch({ type: "view", version });
      } catch (err) {
        fail(g, err);
      }
    },
  };
}
