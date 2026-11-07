import { z } from "zod";
import { MembershipViewSchema } from "./membership.js";

/**
 * Response body for GET /v1/me.
 * Identity is derived from the verified access token; the client cannot
 * supply or override these fields.
 */
export const MeResponseSchema = z.object({
  /** Cognito user sub — the stable, immutable user identifier. */
  userSub: z.string(),
  /** Cognito preferred_username or email claim, for display only. */
  username: z.string(),
  /** All ACTIVE memberships for this user across organizations. */
  memberships: z.array(MembershipViewSchema),
});

export type MeResponse = z.infer<typeof MeResponseSchema>;
