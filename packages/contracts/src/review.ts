import { z } from "zod";
import { EmployeeRefSchema, AssignmentStatusSchema } from "./assignment.js";
import { SubmissionSummarySchema, SubmissionViewSchema } from "./submission.js";

/**
 * The manager's read-only evidence bundle for one frozen submission. Everything
 * here is assembled by the server from persisted records; the browser cannot
 * contribute any of it.
 */

export const TimelineEntrySchema = z.object({
  sequence: z.number().int().positive(),
  type: z.string(),
  occurredAt: z.string(),
  /** Who caused it, relative to the session; raw identities are not exposed. */
  actor: z.enum(["EMPLOYEE", "SYSTEM", "REVIEWER"]),
  summary: z.string(),
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

export const ReviewBundleSchema = z.object({
  submission: SubmissionViewSchema,
  employee: EmployeeRefSchema,
  assignment: z.object({
    assignmentId: z.string(),
    scenarioTitle: z.string(),
    status: AssignmentStatusSchema,
    attemptNumber: z.number().int().positive(),
    /** The attempt currently under review / most recent. A decision is only accepted for this one. */
    latestSubmissionId: z.string().nullable(),
  }),
  /** All attempts for this assignment, newest first, including decisions. */
  history: z.array(SubmissionSummarySchema),
  /** Server-recorded events up to the moment of submission. */
  timeline: z.array(TimelineEntrySchema),
  canDecide: z.boolean(),
});
export type ReviewBundle = z.infer<typeof ReviewBundleSchema>;

export const ReviewBundleResponseSchema = z.object({ review: ReviewBundleSchema });
export type ReviewBundleResponse = z.infer<typeof ReviewBundleResponseSchema>;
