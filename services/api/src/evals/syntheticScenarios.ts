/**
 * Synthetic workplace scenarios for context-builder tests and the pre-live evaluation cases.
 * Nothing here is a real scenario; nothing here is ever published or assigned.
 */
import type { ScenarioCoachingProfile } from "@onboardos/contracts";
import { createSession, type PublishedScenario } from "@onboardos/scenario-engine";
import { buildCoworkerRequest, resolveCoachingProfile, type PriorTurn } from "../coworkerContext.js";

export const NOW = "2026-11-07T10:00:00.000Z";
export const SESSION = { sessionId: "ses_" + "a".repeat(32), assignmentId: "asg_" + "b".repeat(32), organizationId: "canary-org-77", employeeSub: "canary-sub-123" };


// -- two unrelated synthetic scenarios ------------------------------------------------------

/** Test profiles are looked up by scenario OBJECT, so no shared registry state leaks between tests. */
export const PROFILES = new WeakMap<PublishedScenario, unknown>();
export const profileOf = (sc: PublishedScenario) => resolveCoachingProfile(sc, PROFILES.has(sc) ? () => PROFILES.get(sc) : undefined);

export function scenario(over: {
  id: string; title: string; summary: string; ticketId: string; ticketTitle: string; description: string;
  runbookTitle: string; runbookBody: string; diagTitle: string; diagMessages: string[]; baselineMs: number;
  coaching?: ScenarioCoachingProfile; testSuiteId?: string;
}): PublishedScenario {
  const made: PublishedScenario = {
    content: {
      scenarioId: over.id, version: 1, title: over.title, summary: over.summary,
      ticket: {
        id: over.ticketId, title: over.ticketTitle, severity: "SEV3", status: "OPEN", service: "front-desk",
        reportedAt: "2026-11-05T09:00:00Z", reporter: "A. Customer", description: over.description, comments: [],
      },
      runbook: { id: "RB-" + over.id, title: over.runbookTitle, sections: [{ heading: "Policy", body: over.runbookBody }] },
      diagnostics: {
        id: "D-" + over.id, title: over.diagTitle, source: "SYNTHETIC", notice: "Synthetic training data.",
        entries: over.diagMessages.map((message, i) => ({ timestamp: `2026-11-05T09:0${i}:00Z`, level: "INFO" as const, service: "records", message })),
      },
      initialConfig: { request_timeout_ms: over.baselineMs },
    },
    testSuiteId: over.testSuiteId ?? "hidden-suite-canary",
    testSuiteVersion: 1,
    rubricVersion: 9,
  };
  if (over.coaching) PROFILES.set(made, over.coaching);
  return made;
}

export const REFUND_COACHING: ScenarioCoachingProfile = {
  schemaVersion: 1,
  profileId: "test-refund",
  profileVersion: 1,
  audience: { targetRole: "customer support associate", domain: "retail customer service", experienceLevel: "entry" },
  learningObjectives: ["De-escalate a refund dispute.", "Apply the refund policy consistently."],
  successCriteria: ["The customer is told the policy window plainly."],
  terminology: [{ term: "chargeback", meaning: "A forced reversal of a card payment by the bank." }],
  constraints: ["Never promise a refund outside the policy window."],
  reference: [{ title: "Tone guide", body: "Acknowledge the frustration before explaining policy." }],
  coaching: { assistance: "collaborate", hintProgression: "direct_when_asked", tone: "formal", maxWords: 90, offTopic: "brief_help_then_redirect", uncertainty: "ask_first", notes: ["Prefer short examples of wording."] },
};

export const INVENTORY_COACHING: ScenarioCoachingProfile = {
  schemaVersion: 1,
  profileId: "test-inventory",
  profileVersion: 1,
  audience: { targetRole: "inventory analyst", domain: "warehouse operations", experienceLevel: "intermediate" },
  learningObjectives: ["Reconcile counted stock against the ledger."],
  successCriteria: ["Every discrepancy has a documented cause."],
  terminology: [{ term: "cycle count", meaning: "A partial stock count done on a rolling schedule." }],
  constraints: ["Adjustments above the stated tolerance need sign-off."],
  reference: [],
  coaching: { assistance: "explain_only", hintProgression: "questions_first", tone: "neutral", maxWords: 200, offTopic: "redirect", uncertainty: "name_unknowns", notes: [] },
};

export const REFUND = scenario({
  id: "refund-dispute", title: "Refund dispute at the front desk", summary: "A customer demands a refund after the policy window.",
  ticketId: "CASE-77", ticketTitle: "Customer disputes refund decision", description: "The customer bought a kettle 45 days ago and wants a refund.",
  runbookTitle: "Refund policy playbook", runbookBody: "Refunds are allowed within 30 days of purchase.",
  diagTitle: "Order and call records", diagMessages: ["Order ORD-5 placed for kettle", "Call logged: customer upset about refund"], baselineMs: 30,
  coaching: REFUND_COACHING,
});

export const INVENTORY = scenario({
  id: "stock-reconcile", title: "Stock reconciliation for aisle 12", summary: "Counted stock does not match the ledger.",
  ticketId: "INV-310", ticketTitle: "Ledger shows 40 more pallets than counted", description: "The cycle count found 160 pallets; the ledger says 200.",
  runbookTitle: "Reconciliation procedure", runbookBody: "Investigate variances above 5 percent.",
  diagTitle: "Scan and ledger events", diagMessages: ["Pallet scan batch 8 missing", "Ledger adjustment queued"], baselineMs: 50,
  coaching: INVENTORY_COACHING,
});

export const UNPROFILED = scenario({
  id: "plain-task", title: "A task with no coaching profile", summary: "Do the thing.", ticketId: "T-1", ticketTitle: "Do the thing",
  description: "Please do the thing.", runbookTitle: "How to do the thing", runbookBody: "Do it carefully.", diagTitle: "Records", diagMessages: ["Record one"], baselineMs: 10,
});

export const state = (sc: PublishedScenario, over: object = {}) => ({
  ...createSession(sc, SESSION, NOW),
  phase: "INVESTIGATING" as const,
  ...over,
});

export const input = (sc: PublishedScenario, over: object = {}) => ({
  scenario: sc,
  coaching: profileOf(sc),
  state: state(sc),
  currentRun: null,
  history: [] as PriorTurn[],
  message: "What should I look at first?",
  ...over,
});

export const build = (sc: PublishedScenario, over: object = {}) => buildCoworkerRequest(input(sc, over));
export const rulesOf = (system: string) => system.slice(0, system.indexOf("<<<SCENARIO"));
export const dataOf = (system: string) => system.slice(system.indexOf("<<<SCENARIO"));
export const block = (system: string, name: string) => {
  const start = system.indexOf(`<<<${name}`);
  return start < 0 ? "" : system.slice(start, system.indexOf(">>>", start));
};

export function scenarioArgs(sc: PublishedScenario) {
  const c = sc.content;
  return {
    id: c.scenarioId, title: c.title, summary: c.summary, ticketId: c.ticket.id, ticketTitle: c.ticket.title, description: c.ticket.description,
    runbookTitle: c.runbook.title, runbookBody: c.runbook.sections[0]!.body, diagTitle: c.diagnostics.title, diagMessages: c.diagnostics.entries.map((e) => e.message), baselineMs: 1,
  };
}
/**
 * A synthetic copy of `sc` whose diagnostics carry TYPED upstream-latency observations (`upstreamLatencyMs`), one per value, so grounding
 * can be exercised in a domain other than INC-104. Added for the v3.1 evaluation; existing exports are untouched.
 */
export function withLatencies(sc: PublishedScenario, id: string, values: readonly number[], coaching?: ScenarioCoachingProfile): PublishedScenario {
  const entries = values.map((v, i) => ({
    timestamp: `2026-11-05T09:0${i}:00Z`, level: "INFO" as const, service: "scanner-api", message: `POST /v1/sync completed in ${v}ms`, upstreamLatencyMs: v, httpStatus: 200,
  }));
  const made: PublishedScenario = {
    ...sc,
    content: { ...sc.content, scenarioId: id, diagnostics: { ...sc.content.diagnostics, entries: [...sc.content.diagnostics.entries, ...entries] } },
  };
  const profile = coaching ?? (PROFILES.get(sc) as ScenarioCoachingProfile | undefined);
  if (profile) PROFILES.set(made, profile);
  return made;
}
