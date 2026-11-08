/**
 * Governance of what the coworker is taught about a scenario.
 *
 * Honest scope: built-in scenarios and coaching profiles live in code. A deployment changes them for
 * existing assignments too. These tests do not make them immutable at runtime; they make an unversioned
 * change impossible to merge unnoticed (pinned hashes), keep the coaching profile OUT of the published
 * scenario definition, and check provenance against the private evaluator.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_COACHING_PROFILES,
  INC_104_COACHING_V1,
  INC_104_V1,
  PUBLISHED_SCENARIOS,
  getBuiltinCoachingProfile,
  getPublishedScenario,
} from "@onboardos/scenario-fixtures";
import { ScenarioCoachingProfileSchema } from "../coachingProfile.js";
import { coachingProfileHash } from "../coworkerContext.js";

const repo = join(__dirname, "..", "..", "..", "..");

/**
 * PINS. If one of these fails you changed a built-in. Do not just update the hash:
 *  - profile change: bump `profileVersion` in coaching.ts, then update the row below;
 *  - scenario content change: that is a NEW scenario version (and a new evaluator pairing), never an edit of v1.
 */
const PROFILE_PINS = [
  { profileId: "builtin-inc-104-coaching", profileVersion: 1, hash: "sha256:0f6af6460ca534f788a1731d6a8f970125230397e9bb0768c046009c9a34830d" },
] as const;
const SCENARIO_PINS = [
  { scenarioId: "inc-104", version: 1, hash: "sha256:522b5dbe39f56d321684d992c8b5b35a73f8a639e42d8ecddd6c3c32e862fbb5" },
] as const;

describe("versioning: nothing changes silently", () => {
  it("every built-in coaching profile is pinned by id, version and content hash", () => {
    expect(BUILTIN_COACHING_PROFILES.map((e) => ({ profileId: e.profile.profileId, profileVersion: e.profile.profileVersion, hash: coachingProfileHash(e.profile) }))).toEqual(
      PROFILE_PINS,
    );
  });

  it("every published scenario version is pinned by content hash (v1 must stay exactly what was deployed)", () => {
    const sha = (s: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(s)).digest("hex")}`;
    expect(PUBLISHED_SCENARIOS.map((s) => ({ scenarioId: s.content.scenarioId, version: s.content.version, hash: sha(s) }))).toEqual(SCENARIO_PINS);
  });

  it("the published scenario definition does not carry coaching: the profile cannot alter a scenario version", () => {
    expect(Object.keys(INC_104_V1).sort()).toEqual(["content", "rubricVersion", "testSuiteId", "testSuiteVersion"]);
  });
});

describe("registry integrity (the publish-time check for built-ins)", () => {
  it("every entry is valid under the strict schema", () => {
    for (const e of BUILTIN_COACHING_PROFILES) expect(ScenarioCoachingProfileSchema.safeParse(e.profile).success).toBe(true);
  });

  it("every entry belongs to a real published scenario version, and ids are unique", () => {
    for (const e of BUILTIN_COACHING_PROFILES) {
      expect(getPublishedScenario(e.scenarioId, e.scenarioVersion)).toBeDefined();
      expect(getBuiltinCoachingProfile(e.scenarioId, e.scenarioVersion)).toBe(e.profile);
    }
    const ids = BUILTIN_COACHING_PROFILES.map((e) => e.profile.profileId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("an unknown scenario or version has no built-in profile, so platform defaults apply", () => {
    expect(getBuiltinCoachingProfile("inc-104", 2)).toBeUndefined();
    expect(getBuiltinCoachingProfile("nope", 1)).toBeUndefined();
  });

  it("built-in profiles are deeply frozen", () => {
    expect(Object.isFrozen(INC_104_COACHING_V1)).toBe(true);
    expect(Object.isFrozen(INC_104_COACHING_V1.learningObjectives)).toBe(true);
    expect(() => { (INC_104_COACHING_V1.learningObjectives as string[]).push("x"); }).toThrow();
  });
});

describe("provenance: public profile text is not derived from the private evaluator", () => {
  const profileText = JSON.stringify(INC_104_COACHING_V1);
  const publicText = JSON.stringify(INC_104_V1.content);
  const privateSuite = readFileSync(join(repo, "services/test-runner/src/suites/inc104.ts"), "utf8");

  it("shares no private evaluator value with the profile (numbers that the employee is not already shown)", () => {
    const privateNumbers = [...new Set(privateSuite.match(/\b\d{3,}\b/g) ?? [])].filter((n) => !publicText.includes(n));
    expect(privateNumbers.length).toBeGreaterThan(0); // the cross-check really found the hidden thresholds
    for (const n of privateNumbers) expect(profileText, `private value ${n}`).not.toContain(n);
  });

  it("does not name the hidden suite or its cases, and does not mention grading material", () => {
    for (const forbidden of ["inc-104-checkout-timeout", "latency-profile", "revision-hash-matches", "within-policy", "rubric", "answer key", "hidden"]) {
      expect(profileText.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it("legitimate public numbers are allowed (the profile defines '504' and '95%')", () => {
    expect(profileText).toContain("504");
    expect(profileText).toContain("95%");
  });

  it("the employee-visible fixtures package never imports from the runner or any evaluator", () => {
    const dir = join(repo, "packages/scenario-fixtures/src");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/from\s+["'][^"']*(test-runner|suites\/)/);
    }
  });

  it("the API's coaching code never imports from the runner", () => {
    for (const f of ["coworkerContext.ts", "routes/coworker.ts"]) {
      expect(readFileSync(join(repo, "services/api/src", f), "utf8"), f).not.toMatch(/from\s+["'][^"']*test-runner/);
    }
  });
});
