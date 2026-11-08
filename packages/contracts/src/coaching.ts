

export type ExperienceLevel = "entry" | "intermediate" | "advanced";
/** How much the coworker may help. */
export type AssistanceLevel = "explain_only" | "guide" | "collaborate";
/** How concrete hints become as the employee stays stuck. */
export type HintProgression = "questions_first" | "gradual" | "direct_when_asked";
export type Tone = "friendly" | "neutral" | "formal";
/** What to do with a request unrelated to the task. */
export type OffTopicPolicy = "redirect" | "brief_help_then_redirect";
/** What to do when the materials do not answer the question. */
export type UncertaintyPolicy = "name_unknowns" | "ask_first";

export interface CoachingPreferences {
  assistance: AssistanceLevel;
  hintProgression: HintProgression;
  tone: Tone;
  /**
   * Target answer length in words, given to the model as an instruction. It is a SOFT preference, not a limit:
   * the hard bounds are the output token cap (400) and the stored-reply cap (2,000 characters).
   */
  maxWords: number;
  offTopic: OffTopicPolicy;
  uncertainty: UncertaintyPolicy;
  /** Short manager preferences about teaching style. Lower-trust data: never rules. */
  notes: string[];
}

export interface ScenarioCoachingProfile {
  schemaVersion: 1;
  /** Stable identity of this profile and its revision. Bump `profileVersion` on ANY change. */
  profileId: string;
  profileVersion: number;
  audience: { targetRole: string; domain: string; experienceLevel: ExperienceLevel };
  learningObjectives: string[];
  /** PUBLIC success criteria, i.e. what the employee is told success looks like. Never hidden checks. */
  successCriteria: string[];
  terminology: Array<{ term: string; meaning: string }>;
  /** Operational constraints the employee must respect (policy ranges, safety rules). */
  constraints: string[];
  /** Public reference material the employee may also read. */
  reference: Array<{ title: string; body: string }>;
  coaching: CoachingPreferences;
}
