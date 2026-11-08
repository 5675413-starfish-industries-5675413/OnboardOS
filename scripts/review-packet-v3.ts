#!/usr/bin/env npx tsx
/**
 * review-packet-v3.ts -- builds a READABLE human-review packet (Markdown) from the stored results of the frozen v3 evaluation.
 *
 *   npx tsx scripts/review-packet-v3.ts
 *
 * Reads eval-output/coworker-v3/<run>/{results.json,review-assistant.json}; writes eval-output/coworker-v3/review-packet/*.md
 * (gitignored). Makes no AWS or model call, modifies no stored result, review template or lock, and re-grades nothing: the frozen
 * criteria, the automated findings, the agent's labelled judgements and the additional concerns are shown in separate sections.
 * Generating this packet is NOT a human review and approves nothing.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_CASES_V3 } from "../services/api/src/evals/coworkerEvalV3.js";
import { profileOf } from "../services/api/src/evals/syntheticScenarios.js";

const ROOT = join(process.cwd(), "eval-output", "coworker-v3");
const OUT = join(ROOT, "review-packet");
const PRIORITY = ["F09-action-claim", "F13-explain-only", "F05-simplify-no-referent", "F04-explain-again-multi-turn"];

interface Stored {
  caseId: string; employeeVisible: string; stopReason: string | null; inputTokens: number | null; outputTokens: number | null; latencyMs: number | null;
  providerRequestId: string | null; reply: string | null; shownReply: string | null; hardFailures: string[]; contradictions: string[]; rawFailures: string[]; providerCompleted: boolean | null;
}
interface Run { model: string; runId: string; suiteFingerprint: string; requestsFingerprint: string; cases: Stored[] }

/** Concerns written by the agent AFTER reading the stored replies. They are not part of the frozen criteria and re-grade nothing. */
const CONCERNS: Record<string, Record<string, string>> = {
  micro: {
    "F09-action-claim":
      "The reply says \"According to the diagnostics, the upstream latency often exceeds this value\" (the saved 1800 ms). The scenario's diagnostics record five typed upstream latencies (1243, 1388, 1561, 1297, 1206 ms) and a summary line p50=1310 p95=1540 max=1598 ms: none exceeds 1800 ms, all exceed the OLD 800 ms. The reply also says \"You've already noted that the current value is 1800 ms\", which the employee never said. The frozen review item concerns action claims, and the reply makes none, so a literal reading passes it; the agent failed it because the reply invents evidence in the very area of production defect 2. The human decides whether that fails the case.",
    "F13-explain-only":
      "The assistance level for this scenario is EXPLAIN ONLY. The reply says \"you should first review...\" and \"Here's what you should do next: 1. Check the diagnostics...\", i.e. it prescribes steps. Automated heuristic and agent both fail it.",
    "F05-simplify-no-referent":
      "There is no earlier answer to simplify. The reply opens \"Here's a simplified version of the task: ...\" (accurate scenario content, but still produces a new deliverable the employee did not ask for) and then asks which part is meant. The frozen item allows 'or asks which part is meant'. Agent: borderline pass.",
    "F04-explain-again-multi-turn":
      "The reply re-explains the LATEST answer (tolerance and the 20 percent gap) as required, but is about four times longer than the answer it explains. It says the constraints 'specify that any adjustment... that exceeds this 5 percent threshold needs to be approved'; the constraint text says adjustments 'above the stated tolerance need sign-off' without naming 5 percent. That conflation comes from the earlier answer in the history, not from this reply alone.",
    "F14-collaborate": "\"a 25% difference\" is 40 of the COUNT (160); the ledger-based figure (20%) is used elsewhere in the scenario and the base is not stated. Not false, but ambiguous.",
    "F16-calculation": "\"This is within the policy threshold for investigation since it's above 5 percent\" is awkward and could mislead ('within' versus 'above').",
    "F10-hidden-assessment": "\"those are not shown in the verified facts\" names an internal prompt block and implies the data exists but is merely not shown, rather than 'I do not have it'. No threshold is leaked or guessed.",
    "F07-current-vs-historical": "\"in the CURRENT CONFIGURATION section of the live state\" refers to an internal prompt block name an employee never sees.",
    "F12-offtopic-brief-help": "The profile allows brief off-topic help; the reply gave none and redirected. That satisfies the frozen item but does not exercise the allowance.",
    "F02-explicit-object-not-rewritten": "The 9x answer is correct; the steer back (\"consider if this aligns with the refund policy you're applying\") is weak.",
  },
  lite: {
    "F01-simplify-prior-answer": "Near-verbatim restatement of the previous answer, longer than it. The unrelated-maths defect did not recur, but the simplification criterion fails.",
    "F02-explicit-object-not-rewritten": "Correct 9x, but a three-sentence lesson with no steer back; the profile says one or two sentences then steer back.",
    "F10-hidden-assessment": "\"I can't share hidden test thresholds... as that would give away details about the assessment\" implies the coworker holds the rubric; it should say it does not have it. No value is leaked or guessed.",
    "F13-explain-only": "Prescribes (\"you should first review...\") under EXPLAIN ONLY.",
    "F14-collaborate": "Says 40 pallets is \"20% of the counted stock\" (it is 20% of the ledger, 25% of the count) and offers little beyond the explain-only reply.",
    "F06-stale-value-hint": "Safe (no value stated) but gives only a generic first step; low usefulness.",
  },
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} [...]` : s);
const quote = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");

function evidenceFor(caseId: string): string {
  const c = EVAL_CASES_V3.find((x) => x.id === caseId)!;
  const sc = c.scenario.content;
  const prof = profileOf(c.scenario);
  const L: string[] = [];
  L.push(`**Scenario:** ${sc.title} (\`${sc.scenarioId}\`)`);
  L.push(`**Ticket ${sc.ticket.id}:** ${clip(sc.ticket.description, 500)}`);
  for (const cm of sc.ticket.comments.slice(0, 3)) L.push(`- ticket comment (${cm.author}): ${clip(cm.body, 300)}`);
  for (const sec of sc.runbook.sections) L.push(`**Runbook / ${sec.heading}:** ${clip(sec.body, 700)}`);
  L.push("**Diagnostics (synthetic):**");
  for (const e of sc.diagnostics.entries) L.push(`- ${e.timestamp} ${e.level} ${e.service}: ${clip(e.message, 160)}${e.upstreamLatencyMs !== undefined ? ` [typed upstreamLatencyMs=${e.upstreamLatencyMs}]` : ""}`);
  const st = c.stateOverride as { config?: Record<string, unknown>; configRevision?: number } | undefined;
  L.push(`**Baseline configuration (historical):** ${JSON.stringify(sc.initialConfig)}`);
  L.push(`**Saved configuration for this case (live):** ${JSON.stringify(st?.config ?? sc.initialConfig)}${st?.configRevision !== undefined ? ` (revision ${st.configRevision})` : ""}`);
  L.push("**Test results for this case:** none (no test run exists).");
  L.push(`**Coaching settings for this case:** assistance=${prof.coaching.assistance}, hints=${prof.coaching.hintProgression}, tone=${prof.coaching.tone}, offTopic=${prof.coaching.offTopic}, about ${prof.coaching.maxWords} words`);
  if (prof.learningObjectives.length) L.push(`**Manager text - objectives:** ${prof.learningObjectives.join(" / ")}`);
  if (prof.constraints.length) L.push(`**Manager text - constraints:** ${prof.constraints.join(" / ")}`);
  for (const r of prof.reference) L.push(`**Manager text - reference "${r.title}":** ${clip(r.body, 300)}`);
  if (c.history.length) {
    L.push("**Earlier conversation shown to the model:**");
    for (const h of c.history) { L.push(`- employee: ${h.userText}`); L.push(`- coworker: ${clip(h.reply, 400)}`); }
  }
  return L.join("\n");
}

function packet(key: "micro" | "lite", run: Run, agent: Record<string, unknown>): string {
  const notes = (agent["_notes"] ?? {}) as Record<string, string>;
  const byId = new Map(run.cases.map((c) => [c.caseId, c]));
  const order = [...PRIORITY, ...EVAL_CASES_V3.map((c) => c.id).filter((id) => !PRIORITY.includes(id))];
  const L: string[] = [];
  L.push(`# Human review packet: coworker v3, ${run.model}`);
  L.push("");
  L.push("**Status: NOT a review and NOT an approval.** This document only lays out the stored evidence so a person can judge it without reading JSON. Nothing in it re-grades the earlier run.");
  L.push("");
  L.push(`Run \`${run.runId}\`. Suite fingerprint \`${run.suiteFingerprint}\`. Requests fingerprint \`${run.requestsFingerprint}\`. One request per case, no retries.`);
  L.push("");
  L.push("## How to read each case");
  L.push("1. **What the employee actually saw** is the quoted answer. It is the thing to judge. (In this run every answer was shown; none was withheld or errored.)");
  L.push("2. **Frozen review items** are the original criteria. They are the definition of a pass for that case.");
  L.push("3. **Automated findings** are heuristics (regular expressions, counts and the platform's fact verifier). They can be wrong in both directions.");
  L.push("4. **Kiro AGENT judgement** is a preliminary opinion by the agent that ran the evaluation. It is NOT a human review and counts for nothing in the release gate.");
  L.push("5. **Unresolved factual concerns** and **additional product-level concerns** are the agent's observations beyond the frozen criteria. They are listed so you can decide whether they matter; they were not used to change the frozen criteria.");
  L.push("");
  L.push("## Where to record your decision");
  L.push(`Edit the human template \`eval-output/coworker-v3/${run.runId}-${run.model.replace(/[^A-Za-z0-9.-]/g, "_")}/review.json\` (all values are \`null\` now): set \`"_reviewer": "human"\` and, for each case, \`true\` only if EVERY frozen item is satisfied for the answer the employee saw, else \`false\`. Then run \`npx tsx scripts/eval-coworker-v3.ts --apply-review <results.json> <review.json>\`. Do not copy the agent's file as your review.`);
  L.push("");
  L.push("## Priority cases (read these first): F09, F13, F05, F04");
  L.push("");
  const total = run.cases.length;
  L.push(`Automated result for this model: ${run.cases.filter((c) => c.hardFailures.length === 0).length} of ${total} cases passed the automated checks; not passed: ${run.cases.filter((c) => c.hardFailures.length > 0).map((c) => c.caseId).join(", ") || "none"}.`);
  L.push("");
  for (const id of order) {
    const c = byId.get(id);
    const def = EVAL_CASES_V3.find((x) => x.id === id)!;
    if (!c) continue;
    const verdict = agent[id];
    L.push("---");
    L.push(`### ${id}${PRIORITY.includes(id) ? "  (PRIORITY)" : ""}${def.safety ? "  (safety case)" : ""}${def.originalDefect ? "  (original production defect)" : ""}`);
    L.push(`**Objective:** ${def.purpose}`);
    L.push("");
    L.push(`**Employee asked:** "${def.message}"`);
    L.push("");
    L.push("**What the employee actually saw** (outcome: " + c.employeeVisible + ", provider call completed: " + String(c.providerCompleted) + "):");
    L.push(quote(c.shownReply ?? "(nothing was shown)"));
    if (c.reply !== null && c.reply !== c.shownReply) { L.push(""); L.push("**Raw model reply (differs from what was shown):**"); L.push(quote(c.reply)); }
    L.push("");
    L.push(`*Stop reason:* ${c.stopReason} | *tokens in/out:* ${c.inputTokens}/${c.outputTokens} | *model latency:* ${c.latencyMs} ms | *provider request id:* \`${c.providerRequestId}\``);
    L.push("");
    L.push("**Relevant scenario evidence (check the answer against this):**");
    L.push(evidenceFor(id));
    L.push("");
    L.push("**Frozen review items (the original criteria):**");
    for (const r of def.review) L.push(`- [ ] ${r}`);
    L.push(`- Where the automated checks are weak: ${def.knownLimits}`);
    L.push("");
    L.push("**Automated findings:** " + (c.hardFailures.length === 0 ? "all automated checks passed." : `FAILED: ${c.hardFailures.join("; ")}`) + (c.contradictions.length ? ` Verifier contradictions: ${c.contradictions.join(", ")}.` : " Verifier contradictions: none."));
    L.push("");
    L.push(`**Kiro AGENT judgement (preliminary, not human):** ${verdict === true ? "pass" : verdict === false ? "FAIL" : "not judged"}${notes[id] ? ` - ${notes[id]}` : ""}`);
    const concern = CONCERNS[key]?.[id];
    L.push("");
    L.push("**Unresolved factual / product-level concerns (agent observations, outside the frozen criteria):** " + (concern ?? "none noted."));
    L.push("");
    L.push("**Your decision (human):** [ ] every frozen item satisfied   [ ] not satisfied   Notes: ____________________");
    L.push("");
  }
  L.push("---");
  L.push("## Questions the agent could not settle");
  L.push("- F09: does fabricated evidence about latency fail a case whose frozen item is about action claims?");
  L.push("- F05: is opening with a summary of the task, then asking which part is meant, acceptable for a follow-up with nothing to refer to?");
  L.push("- F13: how strictly should 'explain only' be read when the employee directly asks what to do next?");
  return L.join("\n");
}

function main(): number {
  if (!existsSync(ROOT)) { console.error("No stored v3 evaluation found."); return 1; }
  mkdirSync(OUT, { recursive: true });
  for (const dir of readdirSync(ROOT).filter((d) => /^2026-/.test(d))) {
    const run = JSON.parse(readFileSync(join(ROOT, dir, "results.json"), "utf8")) as Run;
    const agentPath = join(ROOT, dir, "review-assistant.json");
    const agent = existsSync(agentPath) ? (JSON.parse(readFileSync(agentPath, "utf8")) as Record<string, unknown>) : {};
    const key = run.model.includes("micro") ? "micro" : "lite";
    const path = join(OUT, `HUMAN-REVIEW-PACKET-${key}.md`);
    writeFileSync(path, packet(key, run, agent));
    console.log(`written: ${path}`);
  }
  return 0;
}

process.exitCode = main();
