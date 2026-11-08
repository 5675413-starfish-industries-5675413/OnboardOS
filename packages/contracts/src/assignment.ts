import { z } from "zod";
import { ScenarioIdSchema } from "./scenario.js";

/**
 * Assignment lifecycle (architecture freeze section E). Only ASSIGNED and
 * IN_PROGRESS are produced by the current slice; the rest are reserved so the
 * contract does not change when submission and review land.
 */
export const AssignmentStatusSchema = z.enum([
  "ASSIGNED",
  "IN_PROGRESS",
  "SUBMITTED",
  "EVALUATING",
  "AWAITING_REVIEW",
  "APPROVED",
  "REVISION_REQUESTED",
]);
export type AssignmentStatus = z.infer<typeof AssignmentStatusSchema>;

/** Cognito subs are UUIDs; this also rules out characters that could alter a DynamoDB key. */
export const UserSubSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const EmployeeRefSchema = z.object({
  userSub: UserSubSchema,
  displayName: z.string(),
});

/**
 * What a client may see of an assignment. `employee` is present only in the
 * manager/admin projection; employees see their own assignments without it.
 * Internal keys, index attributes and the assigning manager's identity are
 * never returned.
 */
export const AssignmentViewSchema = z.object({
  assignmentId: z.string(),
  organizationId: z.string(),
  scenarioId: ScenarioIdSchema,
  scenarioVersion: z.number().int().positive(),
  scenarioTitle: z.string(),
  status: AssignmentStatusSchema,
  sessionId: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  employee: EmployeeRefSchema.optional(),
});
export type AssignmentView = z.infer<typeof AssignmentViewSchema>;

/**
 * Request to assign a published scenario. STRICT: unknown keys are rejected, so
 * a forged `role`, `organizationId`, `managerSub` or `status` is an error, not
 * silently ignored. The organization comes from the URL (and is authorized
 * against membership), the assigning manager from the verified token, and the
 * published version from the server.
 */
export const CreateAssignmentRequestSchema = z.strictObject({
  scenarioId: ScenarioIdSchema,
  employeeSub: UserSubSchema,
});
export type CreateAssignmentRequest = z.infer<typeof CreateAssignmentRequestSchema>;

export const CreateAssignmentResponseSchema = z.object({
  assignment: AssignmentViewSchema,
  /** false when an identical assignment already existed (idempotent retry). */
  created: z.boolean(),
});
export type CreateAssignmentResponse = z.infer<typeof CreateAssignmentResponseSchema>;

export const ListAssignmentsResponseSchema = z.object({
  assignments: z.array(AssignmentViewSchema),
});
export type ListAssignmentsResponse = z.infer<typeof ListAssignmentsResponseSchema>;

export const AssignableEmployeeSchema = EmployeeRefSchema.extend({
  teamIds: z.array(z.string()),
});
export type AssignableEmployee = z.infer<typeof AssignableEmployeeSchema>;

export const ListAssignableEmployeesResponseSchema = z.object({
  employees: z.array(AssignableEmployeeSchema),
});
export type ListAssignableEmployeesResponse = z.infer<typeof ListAssignableEmployeesResponseSchema>;
