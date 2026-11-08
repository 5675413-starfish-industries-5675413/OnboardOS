/**
 * Which coaching an assignment uses (milestone M1).
 *
 * Binding (at assignment creation): the organization's published coaching version is resolved ONCE, verified, and its
 * identity + content hash are written into the assignment record. Later publishes never touch that record.
 *
 * Runtime (each coworker question): precedence is
 *   1. the assignment's frozen organization-published reference: exactly that version, verified;
 *   2. else the platform's built-in profile for the scenario version;
 *   3. else the platform defaults.
 * A reference that cannot be verified (missing, malformed, wrong organization or scenario, wrong identity, hash mismatch)
 * is NEVER replaced by anything else: the question is refused with a bounded, non-sensitive error before any
 * reservation or model call, and a structured diagnostic is logged. Nothing about the assignment or session changes.
 */

import type { PublishedScenario } from "@onboardos/scenario-engine";
import { getBuiltinCoachingProfile } from "@onboardos/scenario-fixtures";
import { getPointerItem, getVersionItem, parsePointer, verifyVersion, type VersionFault } from "./coachingStore.js";
import { resolveCoaching, type ResolvedCoaching } from "./coworkerContext.js";
import type { ApiDeps } from "./deps.js";
import { HttpError } from "./http.js";
import type { AssignmentRecord, CoachingRef } from "./records.js";

export const COACHING_UNAVAILABLE = (): HttpError =>
  new HttpError(503, "COACHING_UNAVAILABLE", "The coaching settings for this assignment are unavailable right now. Please tell your manager.");

function logFault(reason: VersionFault | "POINTER_CORRUPT", where: string, p: { organizationId: string; scenarioId: string; scenarioVersion: number; profileVersion?: number; assignmentId?: string }): void {
  console.error(JSON.stringify({ event: "COACHING_PROFILE_UNAVAILABLE", where, reason, ...p }));
}

/**
 * The coaching reference a NEW assignment should carry, or null when the organization has published nothing
 * (the assignment then uses the platform's built-in coaching, exactly as before this milestone).
 * `requestedVersion` pins a specific published version; omitted means the organization's current one.
 */
export async function coachingRefForNewAssignment(
  deps: ApiDeps,
  orgId: string,
  scenario: PublishedScenario,
  requestedVersion: number | undefined,
): Promise<CoachingRef | null> {
  const { scenarioId, version: scenarioVersion } = scenario.content;
  let profileVersion = requestedVersion;
  if (profileVersion === undefined) {
    const item = await getPointerItem(deps.db, orgId, scenarioId, scenarioVersion);
    if (!item) return null;
    const pointer = parsePointer(item);
    if (!pointer || pointer.organizationId !== orgId) {
      logFault("POINTER_CORRUPT", "assignment", { organizationId: orgId, scenarioId, scenarioVersion });
      throw COACHING_UNAVAILABLE();
    }
    profileVersion = pointer.currentProfileVersion;
  }
  const checked = verifyVersion(await getVersionItem(deps.db, orgId, scenarioId, scenarioVersion, profileVersion), {
    organizationId: orgId, scenarioId, scenarioVersion, profileVersion,
  });
  if (!checked.ok) {
    if (requestedVersion !== undefined && checked.fault === "MISSING") {
      throw new HttpError(422, "UNKNOWN_COACHING_VERSION", "That coaching version has not been published for this scenario");
    }
    logFault(checked.fault, "assignment", { organizationId: orgId, scenarioId, scenarioVersion, profileVersion });
    throw COACHING_UNAVAILABLE();
  }
  const r = checked.record;
  return { source: "ORG_PUBLISHED", profileId: r.profileId, profileVersion: r.profileVersion, contentHash: r.contentHash };
}

/** The coaching for one coworker question on this assignment. Throws COACHING_UNAVAILABLE rather than substitute. */
export async function resolveCoachingForAssignment(deps: ApiDeps, assignment: AssignmentRecord, scenario: PublishedScenario): Promise<ResolvedCoaching> {
  const ref = assignment.coachingRef;
  if (!ref) return resolveCoaching(scenario, getBuiltinCoachingProfile);

  const where = {
    organizationId: assignment.organizationId,
    scenarioId: assignment.scenarioId,
    scenarioVersion: assignment.scenarioVersion,
    profileVersion: ref.profileVersion,
    assignmentId: assignment.assignmentId,
  };
  const checked = verifyVersion(
    await getVersionItem(deps.db, assignment.organizationId, assignment.scenarioId, assignment.scenarioVersion, ref.profileVersion),
    { organizationId: assignment.organizationId, scenarioId: assignment.scenarioId, scenarioVersion: assignment.scenarioVersion, profileVersion: ref.profileVersion, profileId: ref.profileId, contentHash: ref.contentHash },
  );
  if (!checked.ok) {
    logFault(checked.fault, "coworker", where);
    throw COACHING_UNAVAILABLE();
  }
  return { profile: checked.record.profile, source: "ORG_PUBLISHED", hash: checked.record.contentHash };
}
