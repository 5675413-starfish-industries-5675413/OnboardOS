/**
 * Built-in AI coworker coaching profiles, keyed by the scenario version they belong to.
 *
 * PROVENANCE: this is an employee-visible package. A profile here may only restate what the scenario
 * materials already tell the employee (background, learning objectives, PUBLIC success criteria,
 * terminology, constraints). Hidden test content, thresholds, rubric text and manager notes belong to
 * the runner/review side and are never copied here. A test cross-checks the private suite's values
 * against this file.
 *
 * VERSIONING: these are platform-authored and ship with the code. They are NOT part of the published
 * scenario version (`PublishedScenario` is unchanged) and are NOT frozen per assignment: a deployment
 * that edits one changes it for existing assignments. Therefore any edit must bump `profileVersion`,
 * and a test pins each profile's content hash so an unversioned change fails CI. Every coworker turn
 * records the profile id, version and hash it was built with.
 */
import type { ScenarioCoachingProfile } from "@onboardos/contracts";

export const INC_104_COACHING_V1: ScenarioCoachingProfile = {
  schemaVersion: 1,
  profileId: "builtin-inc-104-coaching",
  profileVersion: 1,
  audience: { targetRole: "junior cloud engineer", domain: "cloud operations and incident response", experienceLevel: "entry" },
  learningObjectives: [
    "Relate when a failure began to recent configuration changes.",
    "Compare a configured limit with the behaviour actually observed in the logs.",
    "Justify a proposed configuration change with cited evidence and the documented policy range.",
  ],
  successCriteria: [
    "The proposed change is supported by specific log evidence.",
    "The proposed value respects the approved range stated in the runbook.",
    "The report records what was checked, what was found and why the change is proposed.",
  ],
  terminology: [
    { term: "504", meaning: "An HTTP status returned when a gateway or proxy gives up waiting for an upstream service." },
    { term: "upstream", meaning: "The downstream service that checkout-api calls, here the payments provider." },
    { term: "p95", meaning: "The latency that 95% of requests are at or below." },
  ],
  constraints: [
    "Configuration values must stay inside the approved range given in the runbook.",
    "The diagnostics are synthetic training data, not real production telemetry.",
  ],
  reference: [],
  coaching: {
    assistance: "guide",
    hintProgression: "questions_first",
    tone: "friendly",
    maxWords: 150,
    offTopic: "redirect",
    uncertainty: "name_unknowns",
    notes: [],
  },
};

interface BuiltinEntry {
  readonly scenarioId: string;
  readonly scenarioVersion: number;
  readonly profile: ScenarioCoachingProfile;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export const BUILTIN_COACHING_PROFILES: readonly BuiltinEntry[] = deepFreeze([
  { scenarioId: "inc-104", scenarioVersion: 1, profile: INC_104_COACHING_V1 },
]);

/** The built-in profile for an exact scenario version, or undefined (the caller then uses platform defaults). */
export function getBuiltinCoachingProfile(scenarioId: string, scenarioVersion: number): ScenarioCoachingProfile | undefined {
  return BUILTIN_COACHING_PROFILES.find((e) => e.scenarioId === scenarioId && e.scenarioVersion === scenarioVersion)?.profile;
}
