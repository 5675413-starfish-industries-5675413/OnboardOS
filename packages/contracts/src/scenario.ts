import { z } from "zod";

/**
 * Employee-visible scenario content (INC-104 and future scenarios).
 *
 * SECURITY BOUNDARY: everything here is shown to the assigned employee. It must
 * never contain hidden test cases, expected results, rubrics, or manager-only
 * annotations. Test suites and rubrics are referenced elsewhere by identifier
 * only, and their contents never enter this package.
 */

export const ScenarioIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const TicketCommentSchema = z.object({
  author: z.string(),
  at: z.string(),
  body: z.string(),
});

export const TicketSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(["SEV1", "SEV2", "SEV3", "SEV4"]),
  status: z.string(),
  service: z.string(),
  reportedAt: z.string(),
  reporter: z.string(),
  description: z.string(),
  comments: z.array(TicketCommentSchema),
});

export const RunbookSchema = z.object({
  id: z.string(),
  title: z.string(),
  sections: z.array(z.object({ heading: z.string(), body: z.string() })),
});

export const LogEntrySchema = z.object({
  timestamp: z.string(),
  level: z.enum(["INFO", "WARN", "ERROR"]),
  service: z.string(),
  message: z.string(),
  upstreamLatencyMs: z.number().int().nonnegative().optional(),
  httpStatus: z.number().int().optional(),
});

/**
 * Incident diagnostics. `source` is the literal "SYNTHETIC": this data is
 * generated for the exercise and must never be presented as real AWS or
 * production telemetry (architecture invariant 9).
 */
export const DiagnosticsSchema = z.object({
  id: z.string(),
  title: z.string(),
  source: z.literal("SYNTHETIC"),
  notice: z.string(),
  entries: z.array(LogEntrySchema),
});

/** The configuration the employee investigates and (in a later slice) edits. */
export const IncidentConfigSchema = z.strictObject({
  request_timeout_ms: z.number().int(),
});

export const ScenarioPublicSchema = z.object({
  scenarioId: ScenarioIdSchema,
  version: z.number().int().positive(),
  title: z.string(),
  summary: z.string(),
  ticket: TicketSchema,
  runbook: RunbookSchema,
  diagnostics: DiagnosticsSchema,
  initialConfig: IncidentConfigSchema,
});

export type Ticket = z.infer<typeof TicketSchema>;
export type Runbook = z.infer<typeof RunbookSchema>;
export type LogEntry = z.infer<typeof LogEntrySchema>;
export type Diagnostics = z.infer<typeof DiagnosticsSchema>;
export type IncidentConfig = z.infer<typeof IncidentConfigSchema>;
export type ScenarioPublic = z.infer<typeof ScenarioPublicSchema>;
