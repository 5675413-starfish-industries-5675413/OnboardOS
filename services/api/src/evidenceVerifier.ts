/**
 * Verified facts and reply verification (coworker v3). PURE.
 *
 * The model is never the source of truth for whether a test ran or passed, what is saved, whether work was submitted or
 * approved, or whether anything was done. Those facts come from validated server records. This module does two things:
 *
 *   1. builds a small VerifiedFacts object from those records, which the context builder shows to the model as the only
 *      authority for such statements, and which the application itself renders elsewhere (the session page shows the real test
 *      result; the coworker only discusses it);
 *   2. checks a model reply against the same facts BEFORE it is stored or shown, and reports material contradictions.
 *
 * What a contradiction means here: the reply states, as fact, something the verified records contradict (tests passed when there
 * is no passing run; a number of passed checks that is not the real number; the AI having run, saved or submitted something;
 * work submitted or approved when it is not; a saved configuration value that is not the saved value). A reply with a
 * contradiction is withheld by the caller. It is never "corrected" and no replacement evidence is invented.
 *
 * What this is NOT: a hallucination detector. It matches a small set of claim shapes in affirmative sentences and compares them
 * with structured data. It cannot catch every false statement, paraphrase, other language, or claims about things it holds no
 * structured data for, and it can occasionally flag a sentence that is actually fine. It is one layer; the others are the
 * instructions the model receives and the evaluation. The tests state these limits.
 */

export interface RunFacts {
  status: "PASSED" | "FAILED" | "ERROR";
  passed: number;
  total: number;
}

export interface VerifiedFacts {
  /** Test runs requested in this attempt (any outcome). */
  testRunsRequested: number;
  /** The newest finished run for the CURRENT configuration, or null. */
  currentRun: RunFacts | null;
  /** The saved configuration (live). */
  config: Readonly<Record<string, unknown>>;
  /** The scenario's starting configuration (historical). */
  baseline: Readonly<Record<string, unknown>>;
  configRevision: number;
  /** INVESTIGATING or SUBMITTED. */
  phase: string;
  /** The assignment status (for example IN_PROGRESS, AWAITING_REVIEW, APPROVED). */
  assignmentStatus: string;
}

export function buildVerifiedFacts(p: {
  state: { testRunsRequested: number; config: object; configRevision: number; phase: string };
  baseline: object;
  currentRun: { status: string; passedCount: number; totalCount: number } | null;
  assignmentStatus: string;
}): VerifiedFacts {
  const r = p.currentRun;
  const status = r && (r.status === "PASSED" || r.status === "FAILED" || r.status === "ERROR") ? r.status : null;
  return {
    testRunsRequested: p.state.testRunsRequested,
    currentRun: r && status ? { status, passed: r.passedCount, total: r.totalCount } : null,
    config: p.state.config as Record<string, unknown>,
    baseline: p.baseline as Record<string, unknown>,
    configRevision: p.state.configRevision,
    phase: p.state.phase,
    assignmentStatus: p.assignmentStatus,
  };
}

/** The facts as the model is shown them. */
export function describeVerifiedFacts(f: VerifiedFacts): string[] {
  const run = f.currentRun
    ? f.currentRun.status === "ERROR"
      ? "the latest test run produced no results (runner error)"
      : `${f.currentRun.status} (${f.currentRun.passed} of ${f.currentRun.total} checks passed)`
    : "none: no completed test run exists for the current configuration";
  const cfg = Object.entries(f.config).map(([k, v]) => `${k} = ${String(v)}`).join(", ");
  return [
    `Test runs requested in this attempt: ${f.testRunsRequested}.`,
    `Latest test result for the CURRENT configuration: ${run}.`,
    `Current saved configuration (revision ${f.configRevision}): ${cfg}.`,
    `Attempt phase: ${f.phase}. Assignment status: ${f.assignmentStatus}.`,
  ];
}

// -- reply verification -----------------------------------------------------------------------------------------

export type ContradictionKind =
  | "TESTS_PASSED_WITHOUT_PASSING_RUN"
  | "CHECK_COUNT_MISMATCH"
  | "TESTS_RUN_WITHOUT_ANY_RUN"
  | "AI_CLAIMS_ACTION"
  | "SUBMITTED_WITHOUT_SUBMISSION"
  | "APPROVED_WITHOUT_APPROVAL"
  | "CONFIG_VALUE_MISSTATED";

export interface Contradiction {
  kind: ContradictionKind;
}

/** Sentences that hedge, negate, ask, or speak of the future or a hypothetical are not statements of fact. */
const NOT_A_STATEMENT = /\b(?:can'?t|cannot|can not|not|no|never|without|whether|if|unless|haven'?t|hasn'?t|don'?t|doesn'?t|isn'?t|aren'?t|wasn'?t|unable|would|could|should|might|may|once|until|when|after you|ensure|make sure|aim|goal|need to|needs to|want|hope|expect|will|won'?t|let'?s|try)\b/i;

const HISTORICAL = /\b(?:baseline|originally|was|were|previous|previously|earlier|before|logs?|log lines?|historical|old|prior|changed from|started at|used to|had been)\b/i;

/**
 * A sentence that narrates the scenario's own records (logs, runbook, ticket, monitoring) rather than this employee's test run.
 * "The health check passed at 09:01 according to the logs" is a truthful description of evidence, not a claim about the
 * employee's run. Sentences that address the employee's own work ("your") are never exempt. Trade-off, stated plainly: a false
 * claim worded as a log observation is not caught.
 */
const ABOUT_RECORDS = /\b(?:logs?|log lines?|diagnostics?|runbook|ticket|incident|alerts?|monitoring|dashboards?|health[- ]checks?|upstream)\b/i;
const ABOUT_THE_EMPLOYEE = /\b(?:your|you|you've|yours)\b/i;

/** Policy ranges and limits ("between 100 and 2000") are not claims about the saved value. */
const RANGE_OR_LIMIT = /\b(?:between|from|within|at most|at least|up to|no more than|no less than|range|limits?|maximum|minimum|max|min|allowed|policy|threshold|tolerance|recommended)\b/i;

const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 0);

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TESTS_PASSED = /\b(?:tests?|checks?|test cases?|test suite)\b[^.!?\n]{0,40}\b(?:passed|passes|are passing|is passing|succeeded|were successful|all green|came back green)\b|\b(?:passed|passing)\b[^.!?\n]{0,15}\b(?:all|every)\b[^.!?\n]{0,15}\b(?:tests?|checks?)\b/i;
const UNIVERSAL = /\b(?:all|every|both|each|everything|entire|whole|fully)\b/i;
// A pass count needs a "passed" word, so an unrelated "2 of 5 checks to try first" is not read as a result.
const COUNT = /(\d+)\s*(?:of|out of|\/)\s*(\d+)\s*(?:checks?|tests?|test cases?)\s+(?:passed|pass|passing|succeeded)\b|\bpassed\s+(\d+)\s*(?:of|out of|\/)\s*(\d+)/i;
// "ran" and "were run" describe an execution. "returned"/"completed" are NOT used on their own: "the health check returned 504" is log narration.
const TESTS_RAN = /\b(?:tests?|checks?|test suite)\s+(?:ran|were run|have run|has run|was run|was executed|were executed)\b|\btest run\b[^.!?\n]{0,20}\b(?:completed|finished|came back|returned)\b|\byou(?:'ve| have)?\s+(?:already\s+)?run\s+(?:the\s+)?(?:tests?|checks?)\b/i;
// First-person action claims need an action OBJECT, so "I'll run through the evidence" or "I set out the options" are not flagged.
const AI_ACTION = /\bI(?:'ve| have|'m| am|'ll| will)?\s+(?:just |now |already |successfully )?(?:ran|run|running|start(?:ed)?|save[ds]?|submit(?:ted)?|approve[ds]?|update[ds]?|chang(?:e|ed)|appl(?:y|ied)|set|configure[ds]?|deploy(?:ed)?|execute[ds]?)\s+(?:\w+\s+){0,3}?(?:tests?|checks?|test run|test suite|config(?:uration)?|settings?|values?|timeouts?|request_timeout_ms|reports?|submissions?|work|changes?|fix(?:es)?|it|them|everything)\b/;
const SUBMITTED = /\b(?:your|the)\s+(?:report|attempt|work|submission)\b[^.!?\n]{0,25}\b(?:has been|was|is|were)\s+(?:submitted|sent in)\b/i;
const APPROVED = /\b(?:your|the)\s+(?:report|attempt|work|submission|solution)\b[^.!?\n]{0,25}\b(?:has been|was|is|were)\s+(?:approved|accepted|signed off|marked complete)\b/i;

/**
 * Material contradictions between a model reply and the verified facts. Each kind is reported once. No reply text is returned.
 *
 * Designed to leave truthful technical guidance alone: recommendations ("set request_timeout_ms to 2400"), policy ranges,
 * conditionals, questions, log narration, partial success described as partial, and a first-person "I'll run through the
 * evidence" are not contradictions. It is deliberately narrow, so some false statements pass (see the tests that document this).
 */
export function verifyReply(reply: string, facts: VerifiedFacts): Contradiction[] {
  const found = new Set<ContradictionKind>();
  const run = facts.currentRun;

  for (const s of sentences(reply)) {
    if (s.endsWith("?")) continue;
    const hedged = NOT_A_STATEMENT.test(s);

    // The AI claiming an action: the raw sentence is checked, because "I have run the tests" contains no hedge.
    if (AI_ACTION.test(s) && !/\b(?:can'?t|cannot|can not|unable|not able|won'?t|haven'?t|didn'?t|did not|have not)\b/i.test(s)) found.add("AI_CLAIMS_ACTION");
    if (hedged) continue;

    const aboutRecords = ABOUT_RECORDS.test(s) && !ABOUT_THE_EMPLOYEE.test(s);

    if (TESTS_PASSED.test(s) && !aboutRecords) {
      const hasNumber = /\d/.test(s);
      if (!run) found.add("TESTS_PASSED_WITHOUT_PASSING_RUN");
      else if (run.status === "ERROR") found.add("TESTS_PASSED_WITHOUT_PASSING_RUN");
      else if (run.status === "FAILED") {
        // "Some checks passed" is true of a partial result. Only a universal claim, or any pass claim when nothing passed, contradicts it.
        if (UNIVERSAL.test(s) && run.passed < run.total) found.add("TESTS_PASSED_WITHOUT_PASSING_RUN");
        else if (run.passed === 0 && !hasNumber) found.add("TESTS_PASSED_WITHOUT_PASSING_RUN");
      }
    }
    const c = COUNT.exec(s);
    if (c && !aboutRecords) {
      const passed = Number(c[1] ?? c[3]);
      const total = Number(c[2] ?? c[4]);
      if (!run) found.add("CHECK_COUNT_MISMATCH");
      else if (run.status !== "ERROR" && (passed !== run.passed || total !== run.total)) found.add("CHECK_COUNT_MISMATCH");
    }
    if (facts.testRunsRequested === 0 && TESTS_RAN.test(s) && !aboutRecords) found.add("TESTS_RUN_WITHOUT_ANY_RUN");
    if (SUBMITTED.test(s) && facts.phase !== "SUBMITTED") found.add("SUBMITTED_WITHOUT_SUBMISSION");
    if (APPROVED.test(s) && facts.assignmentStatus !== "APPROVED") found.add("APPROVED_WITHOUT_APPROVAL");

    // Saved configuration values: only STATEMENTS about a value ("key is 800", "key = 800", "key (800)", "key: 800"). Recommendations
    // ("set key to 2400") and policy ranges are not statements about the saved value. Only numbers, only where the key itself is named.
    if (!HISTORICAL.test(s) && !RANGE_OR_LIMIT.test(s)) {
      for (const [key, value] of Object.entries(facts.config)) {
        if (typeof value !== "number") continue;
        const k = esc(key);
        const m = new RegExp(`\\b${k}\\b[\`'"*]*\\s*(?:\\(\\s*(\\d[\\d,]*)|(?:is|are|=|:|equals|currently|now|stands at|reads)\\s*[^.!?\\n\\d]{0,15}(\\d[\\d,]*))`, "i").exec(s);
        if (m) {
          const n = Number(((m[1] ?? m[2]) as string).replace(/,/g, ""));
          if (n !== value) found.add("CONFIG_VALUE_MISSTATED");
        }
      }
    }
  }
  return [...found].map((kind) => ({ kind }));
}

// -- what the employee actually gets -----------------------------------------------------------------------------

/**
 * The single decision about a provider reply, shared by the chat route and the v3 evaluation so that the evaluation measures what
 * employees would really see.
 *
 *   ANSWER               the reply is stored and shown (it may still be `truncated` if the provider stopped at the token limit);
 *   WITHHELD_UNVERIFIED  a contradiction with the verified facts: nothing of the reply is stored or shown. A successful safety
 *                        interception, and NOT a successful answer.
 */
export type ReplyDisposition =
  | { visible: "ANSWER"; text: string; truncated: boolean; contradictions: [] }
  | { visible: "WITHHELD_UNVERIFIED"; text: null; truncated: false; contradictions: Contradiction[] };

export function disposeReply(reply: { text: string; truncated: boolean }, facts: VerifiedFacts, maxChars: number): ReplyDisposition {
  const text = reply.text.length > maxChars ? reply.text.slice(0, maxChars) : reply.text;
  const contradictions = verifyReply(text, facts);
  if (contradictions.length > 0) return { visible: "WITHHELD_UNVERIFIED", text: null, truncated: false, contradictions };
  return { visible: "ANSWER", text, truncated: reply.truncated || text.length < reply.text.length, contradictions: [] };
}
