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

  const assignmentId = assignmentIdFor(orgId, scenario.content.scenarioId, scenario.content.version, target.userSub);
  const candidate = buildAssignmentRecord({
    assignmentId,
    organizationId: orgId,
    scenario,
    employeeSub: target.userSub,
    employeeDisplayName: target.displayName,
    assignedBySub: auth.userSub,
    now: deps.now(),
  });

  // Create-if-absent. A retry (or a double click) finds the same deterministic id and
  // returns the existing assignment instead of creating a second one.
  const created = await putAssignmentIfAbsent(deps.db, candidate);
  let record: AssignmentRecord | null = candidate;
  if (!created) {
    record = parseAssignment(await getAssignmentItem(deps.db, assignmentId));
    if (!record || record.organizationId !== orgId || record.employeeSub !== target.userSub) {
      throw new Error("existing assignment record is missing or malformed");
    }
  }

  return json(
    created ? 201 : 200,
    CreateAssignmentResponseSchema.parse({ assignment: toAssignmentView(record, true), created }),
  );
}
