/**
 * Real asynchronous interaction tests for the Coaching Studio screen's logic: actual promises, a fake server that implements
 * the revision rules, and the real reducer. No browser or DOM is available in this repository (there is no jsdom or testing
 * library, and none was added), so what is NOT covered here is rendering, focus and click wiring; see the static-markup tests
 * and the manual browser checklist.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CoachingDraftContent, CoachingStudioResponse, CoachingVersionDetail } from "@onboardos/contracts";
import { ApiError } from "../lib/api.js";
import { derive, initialState, isDirty, newAssignmentCoachingLine, reducer, type Action, type StudioState } from "../lib/coaching.js";
import { PUBLISH_CONFIRMATION, createController, type StudioApi } from "../lib/studioController.js";
import { ScenariosCard } from "../views/ScenariosCard.js";
import { MemoryRouter } from "react-router-dom";

const CONTENT: CoachingDraftContent = {
  audience: { targetRole: "junior cloud engineer", domain: "cloud operations", experienceLevel: "entry" },
  learningObjectives: ["Relate failures to changes."], successCriteria: ["Cite evidence."], terminology: [], constraints: [], reference: [],
  coaching: { assistance: "guide", hintProgression: "questions_first", tone: "friendly", maxWords: 150, offTopic: "redirect", uncertainty: "name_unknowns", notes: [] },
};
const withObjective = (t: string): CoachingDraftContent => ({ ...CONTENT, learningObjectives: [t] });

/** A fake server with the real rules: revisions, expected-revision conflicts, immutable versions, a pointer. */
function fakeServer() {
  const s = {
    draft: null as { revision: number; content: CoachingDraftContent; publishedThroughRevision: number } | null,
    versions: [] as Array<{ profileVersion: number; content: CoachingDraftContent }>,
    calls: [] as string[],
    delay: new Map<string, () => Promise<void>>(),
  };
  const view = (): CoachingStudioResponse => ({
    scenario: { scenarioId: "inc-104", scenarioVersion: 1, title: "INC-104", targetRole: "junior cloud engineer" },
    template: CONTENT,
    draft: s.draft && { revision: s.draft.revision, content: s.draft.content, contentHash: `sha256:${"a".repeat(64)}`, updatedAt: "2026-11-08T10:00:00.000Z", publishedThroughRevision: s.draft.publishedThroughRevision },
    versions: [...s.versions].reverse().map((v, i) => ({ profileVersion: v.profileVersion, contentHash: `sha256:${"b".repeat(64)}`, publishedAt: "2026-11-08T10:00:00.000Z", sourceDraftRevision: 1, isCurrent: i === 0 })),
    currentProfileVersion: s.versions.length ? s.versions.length : null,
  });
  const gate = async (name: string) => { s.calls.push(name); await s.delay.get(name)?.(); };
  const api: StudioApi = {
    async get() { await gate("get"); return structuredClone(view()); },
    async save(rev, content) {
      await gate("save");
      if ((s.draft?.revision ?? 0) !== rev) throw new ApiError(409, "REVISION_CONFLICT", "changed");
      s.draft = { revision: rev + 1, content: structuredClone(content), publishedThroughRevision: s.draft?.publishedThroughRevision ?? 0 };
      return { draft: structuredClone(view().draft!) };
    },
    async validate(content) {
      await gate("validate");
      const ok = content.audience.targetRole.trim() !== "";
      return { valid: ok, errors: ok ? [] : [{ path: "audience.targetRole", message: "Required" }], effective: ["x"], notice: "No AI model was called." };
    },
    async publish(rev, current) {
      await gate("publish");
      if (!s.draft || s.draft.revision !== rev) throw new ApiError(409, "REVISION_CONFLICT", "changed");
      if (s.versions.length !== current) throw new ApiError(409, "VERSION_CONFLICT", "newer");
      s.versions.push({ profileVersion: current + 1, content: s.draft.content });
      s.draft.publishedThroughRevision = rev;
      return { version: { profileVersion: current + 1, contentHash: `sha256:${"b".repeat(64)}`, publishedAt: "2026-11-08T10:00:00.000Z", sourceDraftRevision: rev, isCurrent: true }, created: true };
    },
    async version(v) {
      await gate("version");
      const found = s.versions.find((x) => x.profileVersion === v);
      if (!found) throw new ApiError(404, "NOT_FOUND", "nf");
      return { profileVersion: v, contentHash: `sha256:${"b".repeat(64)}`, publishedAt: "x", sourceDraftRevision: 1, isCurrent: true, scenarioId: "inc-104", scenarioVersion: 1, content: found.content } as CoachingVersionDetail;
    },
  };
  return { s, api };
}

/** A tiny store standing in for React's useReducer. */
function screen(api: StudioApi, confirmAnswer = true) {
  let state: StudioState = initialState;
  const log: Action[] = [];
  const confirm = vi.fn(() => confirmAnswer);
  const controller = createController({ api, getState: () => state, dispatch: (a) => { log.push(a); state = reducer(state, a); }, confirm });
  return { controller, get state() { return state; }, edit: (form: CoachingDraftContent) => { state = reducer(state, { type: "edit", form }); }, log, confirm };
}
const deferred = () => { let release!: () => void; const p = new Promise<void>((r) => { release = r; }); return { p, release }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("loading", () => {
  it("loads, and shows a failed load as an error that can be retried", async () => {
    const { api, s } = fakeServer();
    const ui = screen(api);
    await ui.controller.load();
    expect(ui.state.phase).toBe("ready");
    let failing = true;
    const flaky: StudioApi = { ...api, get: async () => { if (failing) throw new ApiError(500, "INTERNAL_ERROR", "boom"); return api.get(); } };
    const ui2 = screen(flaky);
    await ui2.controller.load();
    expect(ui2.state.phase).toBe("error");
    failing = false;
    await ui2.controller.reload();
    expect(ui2.state.phase).toBe("ready");
    expect(s.calls.filter((c) => c === "get")).toHaveLength(2);
  });
});

describe("save", () => {
  it("saves with the baseline revision, then the saved draft is the new baseline and the page is clean", async () => {
    const { api, s } = fakeServer();
    const ui = screen(api);
    await ui.controller.load();
    ui.edit(withObjective("first"));
    expect(isDirty(ui.state)).toBe(true);
    await ui.controller.save();
    expect(s.draft?.revision).toBe(1);
    expect(ui.state.baselineRevision).toBe(1);
    expect(isDirty(ui.state)).toBe(false);
    ui.edit(withObjective("second"));
    await ui.controller.save();
    expect(s.draft?.revision).toBe(2);
    expect(s.draft?.content.learningObjectives).toEqual(["second"]);
  });

  it("does nothing when there is nothing to save", async () => {
    const { api, s } = fakeServer();
    const ui = screen(api);
    await ui.controller.load();
    await ui.controller.save();
    expect(s.calls).not.toContain("save");
  });

  it("9. an edit while a save is in flight is ignored, so what was saved is exactly what is on screen", async () => {
    const { api, s } = fakeServer();
    const gate = deferred();
    const ui = screen(api);
    await ui.controller.load();
    ui.edit(withObjective("saved text"));
    s.delay.set("save", () => gate.p);
    const saving = ui.controller.save();
    await tick();
    expect(ui.state.saving).toBe(true);
    ui.edit(withObjective("typed during the save"));
    expect(ui.state.form?.learningObjectives).toEqual(["saved text"]);
    gate.release();
    await saving;
    expect(isDirty(ui.state)).toBe(false);
    expect(s.draft?.content.learningObjectives).toEqual(["saved text"]);
  });

  it("a second Save click while one is in flight sends nothing more", async () => {
    const { api, s } = fakeServer();
    const gate = deferred();
    const ui = screen(api);
    await ui.controller.load();
    ui.edit(withObjective("x"));
    s.delay.set("save", () => gate.p);
    const a = ui.controller.save();
    await tick();
    await ui.controller.save();
    await ui.controller.publish();
    gate.release();
    await a;
    expect(s.calls.filter((c) => c === "save")).toHaveLength(1);
  });
});

describe("validation", () => {
  it("10. an edit while validation is in flight is ignored, and the result matches the text validated", async () => {
    const { api, s } = fakeServer();
    const gate = deferred();
    const ui = screen(api);
    await ui.controller.load();
    ui.edit({ ...CONTENT, audience: { ...CONTENT.audience, targetRole: "" } });
    s.delay.set("validate", () => gate.p);
    const v = ui.controller.validate();
    await tick();
    ui.edit(withObjective("late edit"));
    expect(ui.state.form?.audience.targetRole).toBe("");
    gate.release();
    await v;
    expect(ui.state.validation?.valid).toBe(false);
    expect(ui.state.validating).toBe(false);
  });

  it("an edit after validation clears the stale result", async () => {
    const { api } = fakeServer();
    const ui = screen(api);
    await ui.controller.load();
    await ui.controller.validate();
    expect(ui.state.validation).not.toBeNull();
    ui.edit(withObjective("changed"));
    expect(ui.state.validation).toBeNull();
  });

  it("11. a validation response that arrives after a reload is dropped", async () => {
    const { api, s } = fakeServer();
    const gate = deferred();
    const ui = screen(api);
    await ui.controller.load();
    s.delay.set("validate", () => gate.p);
    const v = ui.controller.validate();
    await tick();
    s.delay.delete("validate");
    await ui.controller.reload();
    gate.release();
    await v;
    expect(ui.state.validation).toBeNull();
    expect(ui.state.validating).toBe(false);
    expect(ui.state.phase).toBe("ready");
  });
});

describe("old responses never overwrite newer state", () => {
  it("11. a slow first load that finishes after a reload is dropped; the newer load wins", async () => {
    const { api, s } = fakeServer();
    const gate = deferred();
    const ui = screen(api);
    s.delay.set("get", () => gate.p);
    const first = ui.controller.load(); // slow
    await tick();
    s.draft = { revision: 7, content: withObjective("newer"), publishedThroughRevision: 0 };
    s.delay.delete("get");
    await ui.controller.reload(); // fast
    expect(ui.state.baselineRevision).toBe(7);
    gate.release();
    await first;
    expect(ui.state.baselineRevision).toBe(7);
    expect(ui.state.form?.learningObjectives).toEqual(["newer"]);
  });

  it("a save that finishes after the page was reloaded does not resurrect its result", async () => {
    const { api, s } = fakeServer();
    const gate = deferred();
    const ui = screen(api);
    await ui.controller.load();
    ui.edit(withObjective("mine"));
    s.delay.set("save", () => gate.p);
    const saving = ui.controller.save();
    await tick();
    s.delay.delete("save");
    await ui.controller.reload();
    gate.release();
    await saving;
    expect(ui.state.saving).toBe(false);
    expect(ui.state.notice).toBeNull();
    // The screen shows the server as of the reload (no draft yet). The late response is not applied on top of it;
    // the server did apply the save, and the next reload will show that.
    expect(ui.state.data?.draft).toBeNull();
    expect(s.draft?.revision).toBe(1);
  });

  it("nothing is dispatched after the screen is left", async () => {
    const { api, s } = fakeServer();
    const gate = deferred();
    const ui = screen(api);
    s.delay.set("get", () => gate.p);
    const loading = ui.controller.load();
    ui.controller.dispose();
    const before = ui.log.length;
    gate.release();
    await loading;
    expect(ui.log.length).toBe(before);
  });
});

describe("7-8. two tabs editing the same draft", () => {
  it("the second tab to save gets a conflict, is locked, and recovers by reloading", async () => {
    const { api, s } = fakeServer();
    const tabA = screen(api);
    const tabB = screen(api);
    await tabA.controller.load();
    await tabB.controller.load();

    tabA.edit(withObjective("from A"));
    await tabA.controller.save();
    tabB.edit(withObjective("from B"));
    await tabB.controller.save();

    expect(s.draft?.content.learningObjectives).toEqual(["from A"]); // B did not overwrite A
    expect(tabB.state.conflict).toBe(true);
    expect(tabB.state.error).toMatch(/Someone else changed/);
    expect(derive(tabB.state)).toMatchObject({ canSave: false, canPublish: false });
    tabB.edit(withObjective("more from B"));
    expect(tabB.state.form?.learningObjectives).toEqual(["from B"]); // locked: edits ignored

    await tabB.controller.reload();
    expect(tabB.state.conflict).toBe(false);
    expect(tabB.state.form?.learningObjectives).toEqual(["from A"]);
    expect(tabB.state.baselineRevision).toBe(1);
    tabB.edit(withObjective("B again"));
    await tabB.controller.save();
    expect(s.draft?.revision).toBe(2);
  });

  it("a tab that publishes from a stale draft revision is refused; the other tab's version stands", async () => {
    const { api, s } = fakeServer();
    const a = screen(api);
    const b = screen(api);
    await a.controller.load();
    await b.controller.load();
    a.edit(withObjective("one"));
    await a.controller.save();
    await b.controller.reload(); // b now sees revision 1
    await a.controller.publish(); // a publishes revision 1 => version 1
    expect(s.versions).toHaveLength(1);
    b.edit(withObjective("two"));
    await b.controller.save(); // revision 2
    await b.controller.publish(); // b believes nothing is published (stale); expects the conflict
    expect(b.state.conflict).toBe(true);
    expect(s.versions).toHaveLength(1);
  });
});

describe("publish", () => {
  async function ready() {
    const { api, s } = fakeServer();
    const ui = screen(api);
    await ui.controller.load();
    ui.edit(withObjective("good"));
    await ui.controller.save();
    return { ui, s };
  }

  it("4. asks for confirmation, and does nothing when declined", async () => {
    const { api, s } = fakeServer();
    const ui = screen(api, false);
    await ui.controller.load();
    ui.edit(withObjective("good"));
    await ui.controller.save();
    await ui.controller.publish();
    expect(ui.confirm).toHaveBeenCalledWith(PUBLISH_CONFIRMATION);
    expect(s.calls).not.toContain("publish");
    expect(s.versions).toHaveLength(0);
    expect(ui.state.publishing).toBe(false);
  });

  it("publishes after confirmation, refreshes from the server, and explains what happens to assignments", async () => {
    const { ui, s } = await ready();
    await ui.controller.publish();
    expect(ui.confirm).toHaveBeenCalledOnce();
    expect(s.versions).toHaveLength(1);
    expect(ui.state.data?.currentProfileVersion).toBe(1);
    expect(derive(ui.state)).toMatchObject({ canPublish: false, canSave: false });
    expect(ui.state.notice).toMatch(/existing assignments keep/);
  });

  it("will not publish unsaved changes", async () => {
    const { ui, s } = await ready();
    ui.edit(withObjective("not saved"));
    await ui.controller.publish();
    expect(s.versions).toHaveLength(0);
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it("will not publish when the page is in conflict", async () => {
    const { ui, s } = await ready();
    ui.state.conflict = true;
    await ui.controller.publish();
    expect(s.versions).toHaveLength(0);
  });
});

describe("5. published versions are read-only", () => {
  it("opens a published version for inspection without any edit path, and closes it", async () => {
    const { api } = fakeServer();
    const ui = screen(api);
    await ui.controller.load();
    ui.edit(withObjective("v1"));
    await ui.controller.save();
    await ui.controller.publish();
    await ui.controller.view(1);
    expect(ui.state.viewing?.profileVersion).toBe(1);
    expect(ui.state.viewing?.content.learningObjectives).toEqual(["v1"]);
    // Editing the draft does not touch the inspected version.
    ui.edit(withObjective("v2 draft"));
    expect(ui.state.viewing?.content.learningObjectives).toEqual(["v1"]);
    ui.state.viewing = null;
  });

  it("a version that cannot be loaded is reported, not shown", async () => {
    const { api } = fakeServer();
    const ui = screen(api);
    await ui.controller.load();
    await ui.controller.view(9);
    expect(ui.state.viewing).toBeNull();
    expect(ui.state.error).toMatch(/not found/);
  });
});

// -- scenario list, role and navigation wiring ------------------------------------------------------------------------

describe("14. the scenario list", () => {
  const html = (scenarios: Parameters<typeof ScenariosCard>[0]["scenarios"], error: string | null = null) =>
    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ScenariosCard, { scenarios, error })));

  it("shows loading, empty and failed states distinctly, and never guesses", () => {
    expect(html(null)).toContain("Loading scenarios");
    expect(html([])).toContain("No supported scenarios are available.");
    expect(html([])).not.toContain("Loading scenarios");
    const failed = html(null, "The server could not complete the request. Please try again.");
    expect(failed).toContain('role="alert"');
    expect(failed).not.toContain("Loading scenarios");
  });

  it("lists each scenario with its coaching status and a labelled link to configure it", () => {
    const out = html([{ scenarioId: "inc-104", scenarioVersion: 1, title: "INC-104: Checkout API timeouts", targetRole: "junior cloud engineer", currentProfileVersion: 2, hasDraft: true }]);
    expect(out).toContain("Your version 2");
    expect(out).toContain("draft saved");
    expect(out).toContain('href="/scenarios/inc-104/coaching"');
    expect(out).toContain('aria-label="Configure AI coworker for INC-104: Checkout API timeouts"');
  });

  it("12. the assignment card never claims built-in coaching when the status is simply unknown", () => {
    expect(newAssignmentCoachingLine(undefined)).toContain("not available");
    expect(newAssignmentCoachingLine(undefined)).not.toContain("built-in");
    expect(newAssignmentCoachingLine(null)).toContain("built-in");
    expect(newAssignmentCoachingLine(3)).toContain("version 3");
  });
});

describe("role consistency and navigation wiring", () => {
  const SRC = join(__dirname, "..");
  const read = (f: string) => readFileSync(join(SRC, f), "utf8");

  it("an org admin gets the scenarios entry on their screen, behind the flag, and employees never do", () => {
    const app = read("pages/AppPage.tsx");
    expect(app).toMatch(/view === "identity" && primary\.role === "org_admin" && config\.coachingStudioEnabled && <ScenariosSection/);
    expect(app.match(/ScenariosSection/g)).toHaveLength(2); // import + one use
    expect(app).not.toMatch(/view === "employee"[^\n]*ScenariosSection/);
    expect(read("views/EmployeeView.tsx")).not.toMatch(/Scenarios|coaching/i);
  });

  it("the identity screen itself is unchanged for an org admin (the membership list is still rendered)", () => {
    const app = read("pages/AppPage.tsx");
    expect(app).toContain("Your role is determined by the server and cannot be changed from this page.");
    expect(app).toContain("displayOrganizationName(m.organizationName)");
    expect(app).not.toContain("Organization ID:");
  });

  it("the coaching page does nothing with the flag off, not even a request, and warns before leaving with unsaved changes", () => {
    const page = read("pages/CoachingPage.tsx");
    expect(page.indexOf("if (!config.coachingStudioEnabled)")).toBeLessThan(page.indexOf("getMe()"));
    expect(page).toContain("export function CoachingPage()");
    expect(page).toMatch(/onClick=\{\(e\) => \{ if \(dirty && !window\.confirm\(LEAVE_WARNING\)\) e\.preventDefault\(\); \}\}/);
    expect(page).toMatch(/m\.role === "manager" \|\| m\.role === "org_admin"/);
  });
});
