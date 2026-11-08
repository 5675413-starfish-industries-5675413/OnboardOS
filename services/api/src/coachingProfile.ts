/**
 * Runtime validation and platform defaults for ScenarioCoachingProfile (the types live in contracts/coaching.ts).
 * Server-only on purpose: see the note there about the browser and runner bundles.
 *
 * The schema is STRICT: an unknown key (rubric, hiddenTests, tools, modelId, ...) fails validation instead of
 * being passed on. Behaviour is chosen from closed enums; the only free text is short, bounded lists.
 */
import { z } from "zod";
import { COACHING_LIMITS, COACHING_TEXT_MAX, type CoachingPreferences, type ScenarioCoachingProfile } from "@onboardos/contracts";

const text = (max: number) => z.string().trim().min(1).max(max);

export { COACHING_LIMITS };

export const CoachingProfileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const CoachingPreferencesSchema = z.strictObject({
  assistance: z.enum(["explain_only", "guide", "collaborate"]),
  hintProgression: z.enum(["questions_first", "gradual", "direct_when_asked"]),
  tone: z.enum(["friendly", "neutral", "formal"]),
  maxWords: z.number().int().min(COACHING_LIMITS.minWords).max(COACHING_LIMITS.maxWords),
  offTopic: z.enum(["redirect", "brief_help_then_redirect"]),
  uncertainty: z.enum(["name_unknowns", "ask_first"]),
  notes: z.array(text(COACHING_TEXT_MAX.item)).max(COACHING_LIMITS.maxNotes),
});

export const ScenarioCoachingProfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profileId: CoachingProfileIdSchema,
  profileVersion: z.number().int().positive(),
  audience: z.strictObject({
    targetRole: text(COACHING_TEXT_MAX.targetRole),
    domain: text(COACHING_TEXT_MAX.domain),
    experienceLevel: z.enum(["entry", "intermediate", "advanced"]),
  }),
  learningObjectives: z.array(text(COACHING_TEXT_MAX.item)).max(COACHING_LIMITS.maxObjectives),
  successCriteria: z.array(text(COACHING_TEXT_MAX.item)).max(COACHING_LIMITS.maxCriteria),
  terminology: z.array(z.strictObject({ term: text(COACHING_TEXT_MAX.term), meaning: text(COACHING_TEXT_MAX.meaning) })).max(COACHING_LIMITS.maxTerms),
  constraints: z.array(text(COACHING_TEXT_MAX.item)).max(COACHING_LIMITS.maxConstraints),
  reference: z.array(z.strictObject({ title: text(COACHING_TEXT_MAX.referenceTitle), body: text(COACHING_TEXT_MAX.referenceBody) })).max(COACHING_LIMITS.maxReferences),
  coaching: CoachingPreferencesSchema,
});

// Compile-time guarantee that the validator and the shared contract types describe the same shape.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const SCHEMA_MATCHES_CONTRACT: Same<z.infer<typeof ScenarioCoachingProfileSchema>, ScenarioCoachingProfile> = true;

/** The platform's approved defaults. Used whenever a scenario version has no profile. */
export const DEFAULT_COACHING_PREFERENCES: CoachingPreferences = {
  assistance: "guide",
  hintProgression: "questions_first",
  tone: "friendly",
  maxWords: 150,
  offTopic: "redirect",
  uncertainty: "name_unknowns",
  notes: [],
};

export const DEFAULT_COACHING_PROFILE: ScenarioCoachingProfile = {
  schemaVersion: 1,
  profileId: "platform-default",
  profileVersion: 1,
  audience: { targetRole: "employee", domain: "the assigned workplace task", experienceLevel: "entry" },
  learningObjectives: [],
  successCriteria: [],
  terminology: [],
  constraints: [],
  reference: [],
  coaching: DEFAULT_COACHING_PREFERENCES,
};
