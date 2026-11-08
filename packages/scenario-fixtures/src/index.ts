/**
 * @onboardos/scenario-fixtures -- employee-visible scenario fixtures ONLY.
 *
 * This package is consumed by the server (to build authorized responses) and
 * must NOT be imported by apps/web: the browser receives scenario content from
 * the API after authorization, never from a bundled copy. Hidden test suites,
 * expected results and rubrics must never be added here.
 */

import type { PublishedScenario } from "@onboardos/scenario-engine";
import { INC_104_V1 } from "./inc104.js";
export type { PublishedScenario } from "@onboardos/scenario-engine";
export { INC_104_V1, INC_104_PUBLIC } from "./inc104.js";
export { BUILTIN_COACHING_PROFILES, INC_104_COACHING_V1, getBuiltinCoachingProfile } from "./coaching.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** Every published scenario version, immutable. A running assignment keeps its version forever. */
export const PUBLISHED_SCENARIOS: readonly PublishedScenario[] = deepFreeze([INC_104_V1]);

/** Exact version lookup (used to resolve an assignment's frozen version). */
export function getPublishedScenario(
  scenarioId: string,
  version: number,
): PublishedScenario | undefined {
  return PUBLISHED_SCENARIOS.find(
    (s) => s.content.scenarioId === scenarioId && s.content.version === version,
  );
}

/** Highest published version of a scenario (used when a manager creates a new assignment). */
export function getLatestPublished(scenarioId: string): PublishedScenario | undefined {
  return PUBLISHED_SCENARIOS.filter((s) => s.content.scenarioId === scenarioId).sort(
    (a, b) => b.content.version - a.content.version,
  )[0];
}
