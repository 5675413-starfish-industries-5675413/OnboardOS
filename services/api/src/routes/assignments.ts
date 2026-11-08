/**
 * Manager-facing routes:
 *   GET  /v1/orgs/{orgId}/assignable-employees
 *   GET  /v1/orgs/{orgId}/assignments
 *   POST /v1/orgs/{orgId}/assignments
 *
 * Who the caller is, which organization, and what role they hold are all
 * derived on the server (verified token + DynamoDB membership). The request
 * body carries only the scenario to assign and the employee to assign it to.
 */

import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  CreateAssignmentRequestSchema,
  CreateAssignmentResponseSchema,
  ListAssignableEmployeesResponseSchema,
  ListAssignmentsResponseSchema,
} from "@onboardos/contracts";
import { getLatestPublished } from "@onboardos/scenario-fixtures";
import { canAssign, loadActiveMembership, NOT_FOUND, requireOrgRole } from "../authz.js";
import { coachingRefForNewAssignment } from "../coachingRuntime.js";
import type { ApiDeps } from "../deps.js";
import { HttpError, json, parseBody, type HttpResult } from "../http.js";
import { assignmentIdFor } from "../ids.js";
import {
  buildAssignmentRecord,
  parseAssignment,
  parseMember,
  toAssignmentView,
  type AssignmentRecord,
} from "../records.js";
import {
  getAssignmentItem,
  listMemberItems,
  putAssignmentIfAbsent,
  queryAssignmentsByEmployee,
  queryAssignmentsByManager,
} from "../repo.js";

/** Employees the caller may assign work to (their team for managers; the whole org for admins). */
export async function handleListAssignableEmployees(
  event: APIGatewayProxyEventV2,
  deps: ApiDeps,
): Promise<HttpResult> {
  const { membership: caller, orgId } = await requireOrgRole(deps, event, ["manager", "org_admin"]);

  const employees = [];
  for (const item of await listMemberItems(deps.db, orgId)) {
    const member = parseMember(item);
    if (!member) {
      console.error(JSON.stringify({ event: "MALFORMED_MEMBERSHIP", organizationId: orgId }));
      continue;
    }
    if (!canAssign(caller, member)) continue;
    // Only what a manager needs to choose someone: no email, no internal attributes.
    employees.push({ userSub: member.userSub, displayName: member.displayName, teamIds: member.teamIds });
  }
  return json(200, ListAssignableEmployeesResponseSchema.parse({ employees }));
}

/**
 * Employees: their own assignments. Managers/admins: assignments they created.
 * (There is no org-wide listing in this slice, by design: no cross-user scan.)
 */
export async function handleListAssignments(
  event: APIGatewayProxyEventV2,
  deps: ApiDeps,
): Promise<HttpResult> {
  const { auth, membership, orgId } = await requireOrgRole(deps, event, ["employee", "manager", "org_admin"]);
  const isEmployee = membership.role === "employee";

  const items = isEmployee
    ? await queryAssignmentsByEmployee(deps.db, orgId, auth.userSub)
    : await queryAssignmentsByManager(deps.db, orgId, auth.userSub);

  const assignments = [];
  for (const item of items) {
    const record = parseAssignment(item);
    // Defense in depth on top of the partition key: re-check ownership of every record.
    const mine = record && record.organizationId === orgId &&
      (isEmployee ? record.employeeSub === auth.userSub : record.assignedBySub === auth.userSub);
    if (!record || !mine) {
      console.error(JSON.stringify({ event: "SKIPPED_ASSIGNMENT_RECORD", organizationId: orgId }));
      continue;
    }
    assignments.push(toAssignmentView(record, !isEmployee));
  }
  return json(200, ListAssignmentsResponseSchema.parse({ assignments }));
}

/** Assign the latest published version of a scenario to an employee in the caller's scope. */
export async function handleCreateAssignment(
  event: APIGatewayProxyEventV2,
  deps: ApiDeps,
): Promise<HttpResult> {
  const { auth, membership: assigner, orgId } = await requireOrgRole(deps, event, ["manager", "org_admin"]);
  const body = parseBody(event, CreateAssignmentRequestSchema);

  const scenario = getLatestPublished(body.scenarioId);
  if (!scenario) throw new HttpError(422, "UNKNOWN_SCENARIO", "That scenario is not published");

  // Uniform 404 for "no such member", "not an employee", "inactive" and "outside your team",
  // so a manager cannot probe for people outside their scope.
  const target = await loadActiveMembership(deps, orgId, body.employeeSub);
  if (!target || !canAssign(assigner, target)) throw NOT_FOUND();

  // The coaching version is deliberately NOT part of the id: publishing must never create assignments or reset progress.
  const assignmentId = assignmentIdFor(orgId, scenario.content.scenarioId, scenario.content.version, target.userSub);

  /**
   * An assignment that already exists is returned exactly as it is. It keeps the coaching it was created with (or none), and
   * asking for different coaching is a conflict, never a rebind. This path reads NO coaching records, so a changed, missing or
   * corrupt published pointer cannot make a valid existing assignment fail.
   */
  const respondExisting = (item: Record<string, unknown> | undefined): HttpResult => {
    const record = parseAssignment(item);
    if (!record || record.organizationId !== orgId || record.employeeSub !== target.userSub) {
      throw new Error("existing assignment record is missing or malformed");
    }
    if (body.coachingProfileVersion !== undefined && record.coachingRef?.profileVersion !== body.coachingProfileVersion) {
      throw new HttpError(409, "COACHING_MISMATCH", "This employee already has this scenario assigned with different coaching, which cannot be changed");
    }
    return json(200, CreateAssignmentResponseSchema.parse({ assignment: toAssignmentView(record, true), created: false }));
  };

  // Retry / double click: look first. Only a genuinely new assignment resolves and pins coaching.
  const already = await getAssignmentItem(deps.db, assignmentId);
  if (already) return respondExisting(already);

  // Pin the organization's published coaching (or the explicitly requested published version) NOW, verified, so a
  // later publish cannot change what this assignment uses. Null => the platform's built-in coaching, as before M1.
  const coachingRef = await coachingRefForNewAssignment(deps, orgId, scenario, body.coachingProfileVersion);

  const candidate = buildAssignmentRecord({
    coachingRef,
    assignmentId,
    organizationId: orgId,
    scenario,
    employeeSub: target.userSub,
    employeeDisplayName: target.displayName,
    assignedBySub: auth.userSub,
    now: deps.now(),
  });

  // Create-if-absent. If a concurrent request created it between our look and our write, the conditional Put loses and
  // the winner's record is returned (with the same conflict rule for an explicit, different coaching request).
  if (!(await putAssignmentIfAbsent(deps.db, candidate))) return respondExisting(await getAssignmentItem(deps.db, assignmentId));
  const record: AssignmentRecord = candidate;
  return json(201, CreateAssignmentResponseSchema.parse({ assignment: toAssignmentView(record, true), created: true }));
}
