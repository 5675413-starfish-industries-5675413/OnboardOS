/**
 * Server-side authorization for the Phase 2B routes (architecture freeze C).
 *
 * Authentication comes from the API Gateway JWT authorizer (see auth.ts). This
 * module adds AUTHORIZATION: an ACTIVE membership in the resource's
 * organization, an allowed role, and (for assignment) team scope. Role,
 * organization and ownership are NEVER taken from the request body, query
 * string, headers, or token claims -- only from the verified subject plus the
 * DynamoDB membership record.
 *
 * Denial shape: no access to an org or resource => 404 (opaque, so ids cannot
 * be probed across tenants or users); a real member lacking the role => 403.
 */

import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { OrgRole } from "@onboardos/contracts";
import { AuthError, extractAuthContext, type AuthContext } from "./auth.js";
import type { ApiDeps } from "./deps.js";
import { HttpError, pathParam } from "./http.js";
import { ORG_ID_PATTERN } from "./ids.js";
import { parseMember, type Member } from "./records.js";
import { getMemberItem } from "./repo.js";

export const NOT_FOUND = (): HttpError => new HttpError(404, "NOT_FOUND", "Not found");

export interface Principal {
  auth: AuthContext;
  membership: Member;
}

/** Verified identity from the gateway's claims. Missing/ID-token => 401. */
export function authenticate(event: APIGatewayProxyEventV2): AuthContext {
  try {
    return extractAuthContext(event);
  } catch (err) {
    if (err instanceof AuthError) {
      throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
    }
    throw err;
  }
}

/**
 * The caller's ACTIVE membership in an organization, or null. A missing,
 * inactive, or malformed record all mean "no access" (fail closed).
 */
export async function loadActiveMembership(
  deps: ApiDeps,
  orgId: string,
  sub: string,
): Promise<Member | null> {
  if (!ORG_ID_PATTERN.test(orgId)) return null;
  const item = await getMemberItem(deps.db, orgId, sub);
  if (!item) return null;
  const member = parseMember(item);
  if (!member) {
    console.error(JSON.stringify({ event: "MALFORMED_MEMBERSHIP", organizationId: orgId }));
    return null;
  }
  return member.status === "ACTIVE" ? member : null;
}

/** Authenticate, then require an ACTIVE membership in the URL's organization with one of `roles`. */
export async function requireOrgRole(
  deps: ApiDeps,
  event: APIGatewayProxyEventV2,
  roles: readonly OrgRole[],
): Promise<Principal & { orgId: string }> {
  const auth = authenticate(event);
  const orgId = pathParam(event, "orgId") ?? "";
  const membership = await loadActiveMembership(deps, orgId, auth.userSub);
  if (!membership) throw NOT_FOUND();
  if (!roles.includes(membership.role)) {
    throw new HttpError(403, "FORBIDDEN", "You do not have permission to perform this action");
  }
  return { auth, membership, orgId };
}

/**
 * May `assigner` assign work to `employee`? Org admins: any employee in the org.
 * Managers: only employees who share at least one team with them. A manager
 * with no teams can assign nobody.
 */
export function canAssign(assigner: Member, employee: Member): boolean {
  if (employee.role !== "employee" || employee.status !== "ACTIVE") return false;
  if (employee.organizationId !== assigner.organizationId) return false;
  if (assigner.role === "org_admin") return true;
  if (assigner.role === "manager") return assigner.teamIds.some((t) => employee.teamIds.includes(t));
  return false;
}
