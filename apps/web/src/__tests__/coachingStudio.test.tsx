import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachingDraftContent, CoachingStudioResponse, CoachingVersionDetail } from "@onboardos/contracts";
import { ApiError, getCoachingStudio, getCoachingVersion, listCoachingScenarios, publishCoaching, saveCoachingDraft, validateCoaching } from "../lib/api.js";
import {
  addItem,
  assignmentCoachingLabel,
  derive,
  describeStudioError,
  errorsFor,
  initialState,
  isDirty,
  moveItem,
  newAssignmentCoachingLine,
  reducer,
  removeAt,
  type StudioState,
} from "../lib/coaching.js";
import { StudioView, VersionReadOnly, type Handlers } from "../views/CoachingStudio.js";
import { setupBrowserEnv, signIn, type FakeStorage } from "./helpers.js";

const CONTENT: CoachingDraftContent = {
  audience: { targetRole: "junior cloud engineer", domain: "cloud operations", experienceLevel: "entry" },
  learningObjectives: ["Relate failures to changes.", "Compare limits with observed behaviour."],
  successCriteria: ["Cite evidence."],
  terminology: [{ term: "504", meaning: "Gateway timeout." }],
  constraints: ["Stay inside the approved range."],
  reference: [{ title: "Guide", body: "Public text." }],
  coaching: { assistance: "guide", hintProgression: "questions_first", tone: "friendly", maxWords: 150, offTopic: "redirect", uncertainty: "name_unknowns", notes: ["Prefer short answers."] },
};

const studioData = (over: Partial<CoachingStudioResponse> = {}): CoachingStudioResponse => ({
  scenario: { scenarioId: "inc-104", scenarioVersion: 1, title: "INC-104: Checkout API timeouts", targetRole: "junior cloud engineer" },
  template: CONTENT, draft: null, versions: [], currentProfileVersion: null, ...over,
});
const draftOf = (revision: number, publishedThrough = 0, content = CONTENT) => ({ revision, content, contentHash: `sha256:${"a".repeat(64)}`, updatedAt: "2026-11-08T10:00:00.000Z", publishedThroughRevision: publishedThrough });
const loaded = (data = studioData()): StudioState => reducer(initialState, { type: "loaded", data });

const noop: Handlers = { edit: () => {}, save: () => {}, validate: () => {}, publish: () => {}, reload: () => {}, view: () => {}, closeView: () => {} };
const html = (s: StudioState) => renderToStaticMarkup(createElement(StudioView, { state: s, on: noop }));

describe("loading and error states", () => {
  it("shows a loading status first", () => {
    const out = html(initialState);
    expect(out).toContain("Loading AI coworker settings");
    expect(out).toContain('role="status"');
    expect(out).not.toContain("<input");
  });

  it("shows a load failure with a way to retry, and no editor", () => {
    const out = html(reducer(initialState, { type: "loadFailed", message: "That scenario was not found, or you do not have access to it." }));
    expect(out).toContain("not found");
    expect(out).toContain('role="alert"');
    expect(out).toContain("Try again");
    expect(out).not.toContain("<textarea");
  });
});

describe("editing state", () => {
  it("starts from the platform template when there is no draft, and from the draft when there is one", () => {
    const fresh = loaded();
    expect(fresh.form).toEqual(CONTENT);
    expect(fresh.baselineRevision).toBe(0);
    const edited = { ...CONTENT, learningObjectives: ["Mine"] };
    const withDraft = loaded(studioData({ draft: draftOf(3, 0, edited) }));
    expect(withDraft.form?.learningObjectives).toEqual(["Mine"]);
    expect(withDraft.baselineRevision).toBe(3);
  });

  it("tracks unsaved changes and clears stale validation on edit", () => {
    let s = loaded();
    expect(isDirty(s)).toBe(false);
    s = reducer(s, { type: "validated", result: { valid: false, errors: [{ path: "audience.targetRole", message: "Required" }], effective: [], notice: "n" } });
    s = reducer(s, { type: "edit", form: { ...CONTENT, learningObjectives: ["changed"] } });
    expect(isDirty(s)).toBe(true);
    expect(s.validation).toBeNull();
  });

  it("warns about unsaved changes on screen, and not when clean", () => {
    const dirty = reducer(loaded(), { type: "edit", form: { ...CONTENT, learningObjectives: ["x"] } });
    expect(html(dirty)).toContain("Unsaved changes");
    expect(html(dirty)).toContain("You will lose these edits");
    expect(html(loaded())).not.toContain("Unsaved changes");
  });

  it("a successful save becomes the new baseline with the new revision", () => {
    let s = reducer(loaded(), { type: "edit", form: { ...CONTENT, learningObjectives: ["x"] } });
    s = reducer(s, { type: "saved", draft: draftOf(1, 0, { ...CONTENT, learningObjectives: ["x"] }) });
    expect(isDirty(s)).toBe(false);
    expect(s.baselineRevision).toBe(1);
    expect(s.notice).toContain("revision 1");
    expect(s.data?.draft?.revision).toBe(1);
  });
});

describe("save and publish availability", () => {
  const saved = (published = 0) => loaded(studioData({ draft: draftOf(2, published), versions: published ? [{ profileVersion: 1, contentHash: `sha256:${"b".repeat(64)}`, publishedAt: "2026-11-08T10:00:00.000Z", sourceDraftRevision: 2, isCurrent: true }] : [], currentProfileVersion: published ? 1 : null }));

  it("save needs changes; publish needs a saved, unpublished, unmodified draft", () => {
    expect(derive(loaded()).canSave).toBe(false);
    expect(derive(loaded()).publishBlockedReason).toMatch(/Save a draft/);
    const dirty = reducer(saved(), { type: "edit", form: { ...CONTENT, learningObjectives: ["x"] } });
    expect(derive(dirty)).toMatchObject({ canSave: true, canPublish: false });
    expect(derive(dirty).publishBlockedReason).toMatch(/Save your changes/);
    expect(derive(saved())).toMatchObject({ canPublish: true, hasUnpublishedChanges: true });
    expect(derive(saved(2))).toMatchObject({ canPublish: false });
    expect(derive(saved(2)).publishBlockedReason).toMatch(/already published/);
  });

  it("nothing can be clicked while a request is in flight", () => {
    const busy = reducer(saved(), { type: "publishStarted" });
    expect(derive(busy)).toMatchObject({ busy: true, canSave: false, canPublish: false });
    expect(html(busy)).toContain("Publishing…");
  });

  it("says which version new assignments will receive", () => {
    expect(derive(loaded()).newAssignmentsUse).toMatch(/built-in coaching/);
    expect(derive(saved(1)).newAssignmentsUse).toBe("your published coaching version 1");
    expect(html(saved(1))).toContain("New assignments will use");
    expect(newAssignmentCoachingLine(2)).toContain("your published version 2");
    expect(newAssignmentCoachingLine(null)).toContain("built-in");
    expect(assignmentCoachingLabel({ source: "ORG_PUBLISHED", profileVersion: 3 })).toBe("Your version 3");
    expect(assignmentCoachingLabel({ source: "BUILT_IN", profileVersion: null })).toBe("Platform built-in");
    expect(assignmentCoachingLabel(undefined)).toBe("—");
  });

  it("a published result refreshes the page state and explains what it does to assignments", () => {
    const refreshed = studioData({ draft: draftOf(2, 2), currentProfileVersion: 1, versions: [{ profileVersion: 1, contentHash: `sha256:${"b".repeat(64)}`, publishedAt: "2026-11-08T10:00:00.000Z", sourceDraftRevision: 2, isCurrent: true }] });
    const s = reducer(saved(), { type: "published", version: refreshed.versions[0]!, refreshed });
    expect(s.notice).toMatch(/existing assignments keep the version they were created with/);
    expect(derive(s).canPublish).toBe(false);
    expect(html(s)).toContain("Current: used by new assignments");
  });
});

describe("conflicts", () => {
  it("maps revision and version conflicts to a locked editor with a reload path", () => {
    for (const code of ["REVISION_CONFLICT", "VERSION_CONFLICT"]) {
      expect(describeStudioError(new ApiError(409, code, "x"))).toMatchObject({ conflict: true });
    }
    expect(describeStudioError(new ApiError(409, "NO_DRAFT", "x"))).toMatchObject({ conflict: false, message: expect.stringMatching(/no saved draft/) });
  });

  it("shows the conflict clearly, offers reload, and disables saving and publishing and editing", () => {
    let s = reducer(loaded(studioData({ draft: draftOf(2) })), { type: "edit", form: { ...CONTENT, learningObjectives: ["mine"] } });
    s = reducer(s, { type: "failed", ...describeStudioError(new ApiError(409, "REVISION_CONFLICT", "x")) });
    const out = html(s);
    expect(out).toContain('data-testid="conflict"');
    expect(out).toContain("changed while you were editing");
    expect(out).toContain("Reload");
    expect(derive(s)).toMatchObject({ canSave: false, canPublish: false });
    expect(out).toMatch(/<textarea[^>]*disabled/);
  });

  it("reloading discards the conflict and the stale edit", () => {
    let s = reducer(loaded(), { type: "failed", message: "m", conflict: true });
    s = reducer(s, { type: "reload" });
    expect(s).toEqual(initialState);
  });
});

describe("other errors are shown plainly", () => {
  it("covers network, permission, not-found, rejection and unknown failures without leaking internals", () => {
    expect(describeStudioError(new ApiError(0, "NETWORK_ERROR", "x")).message).toMatch(/Could not reach/);
    expect(describeStudioError(new ApiError(403, "FORBIDDEN", "x")).message).toMatch(/permission/);
    expect(describeStudioError(new ApiError(404, "NOT_FOUND", "x")).message).toMatch(/not found/);
    expect(describeStudioError(new ApiError(422, "PROFILE_INVALID", "The coaching profile is not valid (2 problems).")).message).toContain("not valid");
    expect(describeStudioError(new ApiError(500, "INTERNAL_ERROR", "stack trace at /var/task")).message).not.toContain("/var/task");
    expect(describeStudioError(new Error("boom")).message).toBe("Something went wrong. Please try again.");
  });
});

describe("validation and preview", () => {
  it("shows each error next to its field, the effective behaviour, and says no model was used", () => {
    let s = loaded();
    s = reducer(s, {
      type: "validated",
      result: {
        valid: false,
        errors: [{ path: "audience.targetRole", message: "Required" }, { path: "learningObjectives[1]", message: "Required" }],
        effective: ["Assistance level GUIDE: point the employee towards what to examine."],
        notice: "This shows the instructions the AI coworker will receive. No AI model was called, and nothing here tests how a model will behave.",
      },
    });
    const out = html(s);
    expect(out).toContain("2 problems to fix before publishing");
    expect(out).toContain("Effective AI coworker behavior");
    expect(out).toContain("Assistance level GUIDE");
    expect(out).toContain("No AI model was called");
    expect(errorsFor(s.validation, "audience.targetRole")).toEqual(["Required"]);
    expect(errorsFor(s.validation, "audience.domain")).toEqual([]);
    expect(errorsFor(null, "x")).toEqual([]);
  });

  it("a valid result says it can be published, without claiming a model was tested", () => {
    const s = reducer(loaded(), { type: "validated", result: { valid: true, errors: [], effective: ["x"], notice: "No AI model was called." } });
    expect(html(s)).toContain("Valid. This configuration can be published.");
    expect(html(s)).not.toMatch(/tested with|model (passed|verified)/i);
  });
});

describe("what the screen says about coaching versus assessment", () => {
  const out = html(loaded());
  it("warns that everything is employee-visible and not to enter grading details", () => {
    expect(out).toContain("visible to the");
    expect(out).toContain("Do not enter grading details");
  });
  it("does not offer assessment configuration and says it is a separate future capability", () => {
    expect(out).toContain("Private assessment");
    expect(out).toContain("not configurable here");
    expect(out).not.toMatch(/<(input|select|textarea)[^>]*(rubric|threshold|answer)/i);
  });
  it("has all editor sections", () => {
    for (const h of ["Audience", "Learning objectives", "Public success criteria", "AI coaching behavior", "Manager coaching notes", "Supporting context", "Validate and preview", "Save and publish"]) {
      expect(out, h).toContain(h);
    }
  });
  it("shows scenario context: title, role, scenario version", () => {
    expect(out).toContain("INC-104: Checkout API timeouts");
    expect(out).toContain("junior cloud engineer");
    expect(out).toContain("Scenario version");
  });
  it("escapes manager-written text", () => {
    const s = reducer(loaded(), { type: "edit", form: { ...CONTENT, learningObjectives: ['<img src=x onerror=alert(1)>'] } });
    expect(html(s)).not.toContain("<img src=x");
  });
});

describe("a published version is inspectable but not editable", () => {
  const v: CoachingVersionDetail = {
    profileVersion: 2, contentHash: `sha256:${"c".repeat(64)}`, publishedAt: "2026-11-08T10:00:00.000Z", sourceDraftRevision: 3, isCurrent: true,
    scenarioId: "inc-104", scenarioVersion: 1, content: CONTENT,
  };
  const out = renderToStaticMarkup(createElement(VersionReadOnly, { v, onClose: () => {} }));

  it("shows the content and says it cannot be changed", () => {
    expect(out).toContain("Published version 2 (read only)");
    expect(out).toContain("Relate failures to changes.");
    expect(out).toContain("cannot be changed");
  });
  it("contains no editable control at all", () => {
    expect(out).not.toMatch(/<(input|textarea|select)/);
    expect(out).toContain("Close");
  });
  it("is shown from state when a version is opened, and can be closed", () => {
    const s = reducer(loaded(), { type: "view", version: v });
    expect(html(s)).toContain('data-testid="version-readonly"');
    expect(html(reducer(s, { type: "closeView" }))).not.toContain('data-testid="version-readonly"');
  });
});

describe("list editing helpers", () => {
  it("moves, removes and adds within bounds", () => {
    expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(removeAt(["a", "b", "c"], 1)).toEqual(["a", "c"]);
    expect(addItem(["a"], "b", 2)).toEqual(["a", "b"]);
    expect(addItem(["a", "b"], "c", 2)).toEqual(["a", "b"]);
  });
  it("the add buttons are disabled at the limit", () => {
    const full = { ...CONTENT, learningObjectives: Array.from({ length: 8 }, (_, i) => `o${i}`) };
    const out = html(loaded(studioData({ draft: draftOf(1, 0, full) })));
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Add objective/);
    expect(out).toContain("8/8");
  });
});

// -- API client ----------------------------------------------------------------------------------------------------------

describe("coaching API client", () => {
  let storage: FakeStorage;
  const fetchMock = vi.fn();
  beforeEach(() => {
    ({ storage } = setupBrowserEnv());
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    signIn(storage, "tok");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const sent = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, method: init.method, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined };
  };

  it("sends only the editable content and the revisions: never an organization, role, owner, version number, status or hash", async () => {
    fetchMock.mockResolvedValue(ok({ draft: draftOf(1) }, 201));
    await saveCoachingDraft("northstar-cloud", "inc-104", 0, CONTENT);
    expect(sent()).toMatchObject({ url: "https://api.example.com/v1/orgs/northstar-cloud/scenarios/inc-104/coaching/draft", method: "PUT" });
    expect(Object.keys(sent().body!).sort()).toEqual(["content", "expectedRevision"]);

    fetchMock.mockResolvedValue(ok({ version: { profileVersion: 1, contentHash: `sha256:${"b".repeat(64)}`, publishedAt: "x", sourceDraftRevision: 1, isCurrent: true }, created: true }, 201));
    await publishCoaching("northstar-cloud", "inc-104", 1, 0);
    expect(sent().method).toBe("POST");
    expect(sent().body).toEqual({ draftRevision: 1, expectedCurrentVersion: 0 });

    fetchMock.mockResolvedValue(ok({ valid: true, errors: [], effective: [], notice: "n" }));
    await validateCoaching("northstar-cloud", "inc-104", CONTENT);
    expect(Object.keys(sent().body!)).toEqual(["content"]);
  });

  it("encodes path segments and uses the right verbs for reads", async () => {
    fetchMock.mockResolvedValue(ok({ scenarios: [] }));
    await listCoachingScenarios("northstar-cloud");
    expect(sent()).toMatchObject({ url: "https://api.example.com/v1/orgs/northstar-cloud/scenarios", method: "GET" });
    fetchMock.mockResolvedValue(ok(studioData()));
    await getCoachingStudio("org/../x", "inc-104");
    expect(sent().url).toContain("org%2F..%2Fx");
    fetchMock.mockResolvedValue(ok({ profileVersion: 1, contentHash: `sha256:${"c".repeat(64)}`, publishedAt: "x", sourceDraftRevision: 1, isCurrent: true, scenarioId: "inc-104", scenarioVersion: 1, content: CONTENT }));
    await getCoachingVersion("northstar-cloud", "inc-104", 1);
    expect(sent()).toMatchObject({ url: "https://api.example.com/v1/orgs/northstar-cloud/scenarios/inc-104/coaching/versions/1", method: "GET" });
  });

  it("rejects a response that breaks the shared contract (for example a model or tool field smuggled into content)", async () => {
    fetchMock.mockResolvedValue(ok({ draft: draftOf(1, 0, { ...CONTENT, tools: ["x"] } as never) }));
    await expect(saveCoachingDraft("o", "inc-104", 0, CONTENT)).rejects.toThrow();
  });

  it("surfaces a conflict as a typed error the screen understands", async () => {
    fetchMock.mockResolvedValue(ok({ code: "REVISION_CONFLICT", message: "changed" }, 409));
    const err = await saveCoachingDraft("o", "inc-104", 2, CONTENT).catch((e: unknown) => e);
    expect(describeStudioError(err).conflict).toBe(true);
  });
});

describe("feature flag and boundary", () => {
  const SRC = join(__dirname, "..");
  beforeEach(() => { setupBrowserEnv(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("the studio is OFF unless the flag is exactly true", async () => {
    const { config } = await import("../lib/config.js");
    vi.stubEnv("VITE_COACHING_STUDIO_ENABLED", "");
    expect(config.coachingStudioEnabled).toBe(false);
    vi.stubEnv("VITE_COACHING_STUDIO_ENABLED", "yes");
    expect(config.coachingStudioEnabled).toBe(false);
    vi.stubEnv("VITE_COACHING_STUDIO_ENABLED", "TRUE");
    expect(config.coachingStudioEnabled).toBe(true);
  });

  it("the page is gated by the flag and only the manager dashboard links to it", () => {
    expect(readFileSync(join(SRC, "pages", "CoachingPage.tsx"), "utf8")).toMatch(/config\.coachingStudioEnabled\)\s*return\s*<Navigate/);
    expect(readFileSync(join(SRC, "views", "ManagerView.tsx"), "utf8")).toMatch(/studio\s*&&/);
  });

  it("the studio code never mentions hidden evaluation internals", () => {
    for (const f of ["views/CoachingStudio.tsx", "lib/coaching.ts", "pages/CoachingPage.tsx"]) {
      expect(readFileSync(join(SRC, f), "utf8"), f).not.toMatch(/inc-104-checkout-timeout|latency-profile|revision-hash-matches|testSuite|rubricVersion/);
    }
  });
});
