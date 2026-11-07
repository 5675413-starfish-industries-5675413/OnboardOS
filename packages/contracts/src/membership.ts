import { z } from "zod";

/**
 * The role a user holds within a specific organization.
 * Authorization is always verified server-side against the DynamoDB membership
 * record — this enum is used for safe display only in the frontend.
 */
export const OrgRoleSchema = z.enum(["org_admin", "manager", "employee"]);
export type OrgRole = z.infer<typeof OrgRoleSchema>;

/**
 * Membership status. Only ACTIVE memberships grant access.
 */
export const MembershipStatusSchema = z.enum(["ACTIVE", "SUSPENDED", "INVITED"]);
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;

/**
 * A single organization membership returned to the authenticated user.
 * Contains only the fields safe for the current user to see about themselves.
 *
 * NOTE: teamIds is included so the frontend can scope UI elements,
 * but authorization decisions are always re-verified by the backend.
 */
export const MembershipViewSchema = z.object({
  organizationId: z.string(),
  organizationName: z.string(),
  role: OrgRoleSchema,
  status: MembershipStatusSchema,
  teamIds: z.array(z.string()),
});

export type MembershipView = z.infer<typeof MembershipViewSchema>;
