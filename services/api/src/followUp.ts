/**
 * Referential follow-up resolution (coworker v3). PURE.
 *
 * Problem observed with a real model: after a technical answer, the message "Simplify." was answered with an unrelated maths
 * problem. The previous answer WAS in the conversation, in the right order; the model simply did not connect the two. The
 * application therefore must not trust the model to resolve a bare reference. When a message is clearly a request to transform
 * or explain the previous answer, the application says so explicitly: it quotes the answer it refers to (bounded) and states
 * what is being asked of it. When there is nothing to refer to, it says that instead of leaving a gap the model fills with an
 * invented task.
 *
 * This is scenario-independent: it knows kinds of follow-up (simplify, clarify, elaborate, shorten, justify), never a scenario,
 * a product, or a fixed reply. A message is a follow-up only if, after the follow-up phrase, nothing but filler remains: any
 * explicit new object ("Simplify 6x + 3x", "Explain the 504 error") means the employee supplied their own subject and the
 * message is left exactly as written.
 *
 * Limits, stated plainly: this is a small lexical and structural rule, not language understanding. It will miss follow-ups
 * phrased in ways it does not list (those are then handled as ordinary messages), and it is English only. A miss degrades to
 * the previous behaviour; it never rewrites a message that contains its own subject.
 */

import { neutralize } from "./coworkerContext.js";

export type FollowUpKind = "SIMPLIFY" | "CLARIFY" | "ELABORATE" | "SHORTEN" | "JUSTIFY";

/** Longest referent quoted back to the model. The reply cap is 2,000 characters, so this keeps most answers whole. */
export const MAX_REFERENT_CHARS = 1500;
const MAX_FOLLOW_UP_WORDS = 9;

const HEADS: ReadonlyArray<readonly [FollowUpKind, RegExp]> = [
  ["SIMPLIFY", /^(?:simplify|simplified|simplif\w*|make (?:it|that|this) (?:a bit |a little )?(?:simpler|easier|clearer)|simpler|dumb (?:it|that|this) down|in plain (?:english|words|terms)|eli5|explain (?:it|that|this) simply)\b/],
  ["SHORTEN", /^(?:shorten|make (?:it|that|this) (?:a bit |a little )?(?:shorter|briefer|more concise)|shorter|tl ?dr|summari[sz]e|in short|briefly|in a nutshell|too long)\b/],
  ["ELABORATE", /^(?:elaborate|expand|tell me more|more (?:detail|details|info|information)|go (?:on|deeper)|go into more detail|give (?:me )?(?:an )?example|for example|an example|show me an example)\b/],
  ["JUSTIFY", /^(?:why|how come|how so|what makes you say that|how do you know|what'?s the reason)\b/],
  ["CLARIFY", /^(?:rephrase|reword|clarify|say (?:it|that|this) (?:more )?(?:clearly|simply|differently)|explain|what do you mean|what does (?:that|this|it) mean|i (?:don'?t|do not) (?:understand|get)|huh|sorry what|come again|repeat|can you repeat)\b/],
];

/** Politeness that may precede the follow-up phrase. */
const LEAD = /^(?:(?:please|pls|ok|okay|so|and|hmm|well|kindly|thanks|thank you)\s+)*(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+(?:need|want)\s+you\s+to\s+|you\s+(?:could|can)\s+|let'?s\s+)?/;

/** Words that may follow the phrase without introducing a subject of their own. Anything else is an explicit object. */
const FILLER = new Set([
  "that", "this", "it", "again", "more", "a", "an", "bit", "little", "clearly", "clear", "simply", "simple", "simpler", "briefly",
  "shorter", "short", "please", "pls", "for", "me", "in", "plain", "words", "english", "detail", "details", "one", "answer", "response",
  "explanation", "last", "previous", "you", "said", "just", "so", "to", "the", "your", "point", "part", "differently", "another", "way",
  "easier", "easy", "terms", "thanks", "thank", "now", "then", "further", "better", "sorry", "is", "do", "mean", "means", "so", "say",
  "of", "on", "up", "down", "out", "about", "its", "mean", "that's", "thats", "what", "does", "go", "deeper", "example", "examples",
]);

const normalize = (s: string): string =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/[.,!?;:"“”()]/g, " ").replace(/\s+/g, " ").trim();

/**
 * The kind of follow-up this message is, or null when it is not a bare reference (including when it supplies its own subject).
 */
export function classifyFollowUp(message: string): FollowUpKind | null {
  const text = normalize(message);
  if (text === "" || text.split(" ").length > MAX_FOLLOW_UP_WORDS) return null;
  const rest = text.replace(LEAD, "");
  for (const [kind, head] of HEADS) {
    const m = head.exec(rest);
    if (!m) continue;
    const tail = rest.slice(m[0].length).trim();
    if (tail === "") return kind;
    // Every remaining word must be filler. One real word (a number, a noun, a symbol) is the employee's own subject.
    if (tail.split(" ").every((w) => FILLER.has(w))) return kind;
    return null;
  }
  return null;
}

const ACTION: Record<FollowUpKind, string> = {
  SIMPLIFY: "wants you to restate that answer in simpler, plainer words",
  CLARIFY: "wants you to explain that answer more clearly, or to say what part of it is unclear",
  ELABORATE: "wants more detail or a concrete example on that answer",
  SHORTEN: "wants that answer made shorter",
  JUSTIFY: "wants the reasoning behind the main claim in that answer",
};

const ONE_LINE = (s: string): string => neutralize(s).replace(/\s+/g, " ").trim();

export interface FramedFollowUp {
  text: string;
  /** True when a previous answer was found and quoted. */
  resolved: boolean;
}

/**
 * The text of the final user turn for a follow-up. The employee's own words stay visible (quoted), so nothing they typed is
 * hidden or replaced; the platform's explanation of what they mean is added around it.
 */
export function frameFollowUp(kind: FollowUpKind, employeeText: string, previousAnswer: string | null): FramedFollowUp {
  const said = ONE_LINE(employeeText).slice(0, 200);
  if (previousAnswer === null || previousAnswer.trim() === "") {
    return {
      resolved: false,
      text:
        `The employee sent a short follow-up message: "${said}"\n` +
        "There is no earlier answer in this conversation for it to refer to. Do not invent a task, an example, a calculation or a topic. " +
        "Say so briefly and ask which part of the task or the materials they mean.",
    };
  }
  const prev = neutralize(previousAnswer.length > MAX_REFERENT_CHARS ? `${previousAnswer.slice(0, MAX_REFERENT_CHARS)} [cut]` : previousAnswer);
  return {
    resolved: true,
    text:
      `The employee sent a short follow-up message: "${said}"\n` +
      `It refers to YOUR PREVIOUS ANSWER, quoted below. The employee ${ACTION[kind]}. ` +
      "Work only from that answer and the facts and evidence it already relied on. Do not start a different task, topic, example or calculation.\n" +
      `PREVIOUS ANSWER:\n<<<\n${prev}\n>>>`,
  };
}

/**
 * coworker v3.1: a bare follow-up with NO earlier answer to refer to is answered by the platform, not the model. The reply is fixed,
 * scenario-independent and invents nothing. The turn still goes through the normal reservation (ordering, idempotency, quota,
 * authorization are unchanged); only the paid model call is skipped.
 */
export const PLATFORM_CLARIFICATION =
  "I don't have an earlier answer of mine to go back to yet. Tell me which part of the task or the materials you would like explained, or ask your question in full, and I will help.";

export function platformClarification(followUp: { kind: FollowUpKind; resolved: boolean } | null): string | null {
  return followUp !== null && !followUp.resolved ? PLATFORM_CLARIFICATION : null;
}
