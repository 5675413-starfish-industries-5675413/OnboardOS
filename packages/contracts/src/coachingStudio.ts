import { z } from "zod";
import { ScenarioIdSchema } from "./scenario.js";

/**
 * Manager Coaching Studio contracts (milestone M1).
 *
 * A manager edits the PUBLIC coaching of a supported scenario: employee-visible learning objectives and success
 * criteria, terminology, constraints, public reference material, and enumerated coaching preferences. Nothing in
 * these contracts can carry hidden tests, thresholds, answer keys, scoring weights, rubric text, model or tool
 * settings, or an organization/role: the objects are STRICT, so any such key is a validation error.
 *
 * Two separate versioning dimensions exist and must not be confused:
 *   - scenarioVersion: the published scenario definition (content + hidden evaluator pairing), owned by the platform;
 *   - profileVersion:  the organization's published coaching for that scenario version, owned by the employer.
 *
 * The strict, authoritative validator is server-side (services/api/src/coachingProfile.ts). The DRAFT schema here is
 * deliberately looser about emptiness (a half-written draft can be saved) but not about size, shape or unknown keys.
 */

export const COACHING_LIMITS = {
  maxObjectives: 8,
  maxCriteria: 8,
  maxTerms: 12,
  maxConstraints: 8,
  maxReferences: 5,
  maxNotes: 5,
  minWords: 40,
  maxWords: 250,
} as const;

export const COACHING_TEXT_MAX = {
  targetRole: 80,
  domain: 80,
  item: 240,
  term: 60,
  meaning: 240,
  referenceTitle: 80,
  referenceBody: 800,
} as const;

/**
 * Free-text "coaching notes" are TEMPORARILY UNAVAILABLE (coworker v3). The first real-model evaluation showed that a small
 * model obeys an imperative sentence in employer text (it repeated "all tests passed" because a note said to). Until free-text
 * instructions can be applied safely, the server rejects them (save, validate, publish) and the Studio says so, rather than
 * accepting guidance that the runtime then ignores. Structured settings, objectives, criteria, terminology, constraints and
 * public reference material remain available. The field stays in the contract so it can return without a migration.
 */
export const COACHING_NOTES_ENABLED = false as boolean;
export const COACHING_NOTES_UNAVAILABLE =
  "Free-text coaching notes are temporarily unavailable. Use the structured settings, learning objectives and supporting context instead.";

const draftText = (max: number) => z.string().max(max);

export const CoachingDraftContentSchema = z.strictObject({
  audience: z.strictObject({
    targetRole: draftText(COACHING_TEXT_MAX.targetRole),
    domain: draftText(COACHING_TEXT_MAX.domain),
    experienceLevel: z.enum(["entry", "intermediate", "advanced"]),
  }),
  learningObjectives: z.array(draftText(COACHING_TEXT_MAX.item)).max(COACHING_LIMITS.maxObjectives),
  successCriteria: z.array(draftText(COACHING_TEXT_MAX.item)).max(COACHING_LIMITS.maxCriteria),
  terminology: z
    .array(z.strictObject({ term: draftText(COACHING_TEXT_MAX.term), meaning: draftText(COACHING_TEXT_MAX.meaning) }))
    .max(COACHING_LIMITS.maxTerms),
  constraints: z.array(draftText(COACHING_TEXT_MAX.item)).max(COACHING_LIMITS.maxConstraints),
  reference: z
    .array(z.strictObject({ title: draftText(COACHING_TEXT_MAX.referenceTitle), body: draftText(COACHING_TEXT_MAX.referenceBody) }))
    .max(COACHING_LIMITS.maxReferences),
  coaching: z.strictObject({
    assistance: z.enum(["explain_only", "guide", "collaborate"]),
    hintProgression: z.enum(["questions_first", "gradual", "direct_when_asked"]),
    tone: z.enum(["friendly", "neutral", "formal"]),
    maxWords: z.number().int().min(0).max(1000),
    offTopic: z.enum(["redirect", "brief_help_then_redirect"]),
    uncertainty: z.enum(["name_unknowns", "ask_first"]),
    notes: z.array(draftText(COACHING_TEXT_MAX.item)).max(COACHING_LIMITS.maxNotes),
  }),
});
export type CoachingDraftContent = z.infer<typeof CoachingDraftContentSchema>;

// -- scenarios ------------------------------------------------------------------------------------

export const CoachingScenarioSummarySchema = z.object({
  scenarioId: ScenarioIdSchema,
  scenarioVersion: z.number().int().positive(),
  title: z.string(),
  /** The role the platform's built-in coaching addresses, when one exists. */
  targetRole: z.string().nullable(),
  /** The organization's current published coaching version, or null (new assignments then use the platform's built-in coaching). */
  currentProfileVersion: z.number().int().positive().nullable(),
  hasDraft: z.boolean(),
});
export type CoachingScenarioSummary = z.infer<typeof CoachingScenarioSummarySchema>;

export const ListCoachingScenariosResponseSchema = z.object({ scenarios: z.array(CoachingScenarioSummarySchema) });
export type ListCoachingScenariosResponse = z.infer<typeof ListCoachingScenariosResponseSchema>;

// -- drafts and versions ---------------------------------------------------------------------------

export const CoachingDraftViewSchema = z.object({
  /** Increments on every save. A save must quote the revision it was based on. */
  revision: z.number().int().positive(),
  content: CoachingDraftContentSchema,
  contentHash: z.string(),
  updatedAt: z.string(),
  /** The newest draft revision that has been published (0 = never). */
  publishedThroughRevision: z.number().int().nonnegative(),
});
export type CoachingDraftView = z.infer<typeof CoachingDraftViewSchema>;

export const CoachingVersionSummarySchema = z.object({
  profileVersion: z.number().int().positive(),
  contentHash: z.string(),
  publishedAt: z.string(),
  sourceDraftRevision: z.number().int().positive(),
  isCurrent: z.boolean(),
});
export type CoachingVersionSummary = z.infer<typeof CoachingVersionSummarySchema>;

export const CoachingVersionDetailSchema = CoachingVersionSummarySchema.extend({
  scenarioId: ScenarioIdSchema,
  scenarioVersion: z.number().int().positive(),
  content: CoachingDraftContentSchema,
});
export type CoachingVersionDetail = z.infer<typeof CoachingVersionDetailSchema>;

export const CoachingStudioResponseSchema = z.object({
  scenario: CoachingScenarioSummarySchema.pick({ scenarioId: true, scenarioVersion: true, title: true, targetRole: true }),
  /** The platform's built-in coaching as an editable starting point (null when the platform has none). */
  template: CoachingDraftContentSchema,
  draft: CoachingDraftViewSchema.nullable(),
  /** Published versions, newest first (bounded). */
  versions: z.array(CoachingVersionSummarySchema),
  /** What a NEW assignment of this scenario will use: this version, or null for the platform's built-in coaching. */
  currentProfileVersion: z.number().int().positive().nullable(),
});
export type CoachingStudioResponse = z.infer<typeof CoachingStudioResponseSchema>;

export const SaveCoachingDraftRequestSchema = z.strictObject({
  /** 0 to create the first draft; otherwise the revision this edit is based on. */
  expectedRevision: z.number().int().nonnegative(),
  content: CoachingDraftContentSchema,
});
export type SaveCoachingDraftRequest = z.infer<typeof SaveCoachingDraftRequestSchema>;

export const SaveCoachingDraftResponseSchema = z.object({ draft: CoachingDraftViewSchema });
export type SaveCoachingDraftResponse = z.infer<typeof SaveCoachingDraftResponseSchema>;

// -- validation preview ---------------------------------------------------------------------------------

export const CoachingValidationErrorSchema = z.object({ path: z.string(), message: z.string() });

export const ValidateCoachingRequestSchema = z.strictObject({ content: CoachingDraftContentSchema });
export type ValidateCoachingRequest = z.infer<typeof ValidateCoachingRequestSchema>;

export const ValidateCoachingResponseSchema = z.object({
  valid: z.boolean(),
  errors: z.array(CoachingValidationErrorSchema),
  /**
   * The platform-written behaviour this configuration selects, one statement per setting. It describes what the
   * coworker will be INSTRUCTED to do. It is not a test of any model, and no model is called to produce it.
   */
  effective: z.array(z.string()),
  notice: z.string(),
});
export type ValidateCoachingResponse = z.infer<typeof ValidateCoachingResponseSchema>;

// -- publishing -------------------------------------------------------------------------------------------

export const PublishCoachingRequestSchema = z.strictObject({
  /** The draft revision being published. Publishing a stale draft is refused. */
  draftRevision: z.number().int().positive(),
  /** The current published version the manager saw (0 = none). Publishing over a newer one is refused. */
  expectedCurrentVersion: z.number().int().nonnegative(),
});
export type PublishCoachingRequest = z.infer<typeof PublishCoachingRequestSchema>;

export const PublishCoachingResponseSchema = z.object({
  version: CoachingVersionSummarySchema,
  /** false when this exact publish had already happened (an idempotent retry). */
  created: z.boolean(),
});
export type PublishCoachingResponse = z.infer<typeof PublishCoachingResponseSchema>;

/** What an assignment says about the coaching it was created with (manager projection only). */
export const AssignmentCoachingViewSchema = z.object({
  source: z.enum(["ORG_PUBLISHED", "BUILT_IN"]),
  profileVersion: z.number().int().positive().nullable(),
});
export type AssignmentCoachingView = z.infer<typeof AssignmentCoachingViewSchema>;
