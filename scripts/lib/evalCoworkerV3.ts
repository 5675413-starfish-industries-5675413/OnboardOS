/**
 * Logic of the coworker-v3 evaluation runner (scripts/eval-coworker-v3.ts). Kept here so it is testable with a fake provider and
 * no network. THIS RUNNER HAS NOT BEEN EXECUTED against a model; the default is a dry run.
 *
 * HARD LIMITS, enforced in code (and tested):
 *   - nothing calls a model unless execute() is invoked, and the entry point only does that for
 *     `--execute-paid-bedrock-inference --model=<allow-listed id> --max-calls=17`;
 *   - exactly one attempt per case: no retry, no second request after a failure, no concurrency, no fallback model;
 *   - a hard ceiling of 17 calls PER MODEL RUN, and one lock file per model (EXECUTED-<model>.lock) that blocks a second run of
 *     the same model until a person deletes it. Comparing several models is several separately approved runs;
 *   - the region is us-east-1 only; the model must be on the allow-list AND marked runnable; environment overrides that
 *     disagree are refused;
 *   - the evaluated requests must match the pinned fingerprints (stale builds and edited prompts are refused);
 *   - this suite has its own output directory and lock and never touches the frozen v2 lock or v2 artifacts.
 *
 * What it does NOT touch: OnboardOS API endpoints, Cognito, DynamoDB, CloudFormation, Vercel, the scenario runner Lambda, any
 * employee session, IAM. It authenticates as no employee. The only AWS call it can make is Bedrock Converse on the one named
 * model, through the same provider the product uses (participant credentials, not the deployed API role).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  COWORKER_CALL_TIMEOUT_MS,
  COWORKER_MAX_OUTPUT_TOKENS,
  COWORKER_TEMPERATURE,
  CoworkerProviderError,
  type CoworkerReply,
  type CoworkerRequest,
} from "../../services/api/src/bedrock.js";
import { COWORKER_PROMPT_VERSION_V3 } from "../../services/api/src/coworkerContextV3.js";
import {
  EVAL_CASES_V3,
  EVAL_V3_MODELS,
  EVAL_V3_REGION,
  FROZEN_REQUESTS_FINGERPRINT_V3,
  FROZEN_SUITE_FINGERPRINT_V3,
  SUITE_CRITERIA_V3,
  buildEvalRequestV3,
  buildGateV3,
  checkAssemblyV3,
  evaluateReplyV3,
  requestsFingerprintV3,
  suiteFingerprintV3,
  usageBudgetV3,
  worstCaseCostUsd,
  type EmployeeVisible,
  type GateV3,
  type ReviewerKind,
} from "../../services/api/src/evals/coworkerEvalV3.js";
import type { LiveRecord } from "../../services/api/src/evals/coworkerEval.js";
import { INC_104_V1 } from "@onboardos/scenario-fixtures";

export const PAID_FLAG = "--execute-paid-bedrock-inference";
export const MAX_CALLS_FLAG = `--max-calls=${SUITE_CRITERIA_V3.maxCallsPerModelRun}`;
export const MODEL_FLAG_PREFIX = "--model=";
export const OUT_DIR = "eval-output/coworker-v3";
export const paidCommand = (model: string): string => `npx tsx scripts/eval-coworker-v3.ts ${PAID_FLAG} ${MODEL_FLAG_PREFIX}${model} ${MAX_CALLS_FLAG}`;
export const lockFileFor = (model: string): string => `EXECUTED-${model.replace(/[^A-Za-z0-9.-]/g, "_")}.lock`;

export interface EvalProvider {
  readonly modelId: string;
  converse(request: CoworkerRequest): Promise<CoworkerReply>;
}

// -- arguments --------------------------------------------------------------------------------------

export type Command =
  | { mode: "dry-run" }
  | { mode: "help" }
  | { mode: "execute"; model: string }
  | { mode: "apply-review"; results: string; review: string }
  | { mode: "error"; message: string };

export function parseArgs(argv: readonly string[]): Command {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--dry-run")) return { mode: "dry-run" };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { mode: "help" };
  if (argv[0] === "--apply-review") {
    if (argv.length !== 3) return { mode: "error", message: "--apply-review needs exactly two files: <results.json> <review.json>" };
    return { mode: "apply-review", results: argv[1]!, review: argv[2]! };
  }
  if (argv.includes(PAID_FLAG)) {
    const rest = argv.filter((a) => a !== PAID_FLAG);
    const models = rest.filter((a) => a.startsWith(MODEL_FLAG_PREFIX));
    const others = rest.filter((a) => !a.startsWith(MODEL_FLAG_PREFIX));
    if (models.length !== 1 || others.length !== 1 || others[0] !== MAX_CALLS_FLAG) {
      return { mode: "error", message: `Refusing: paid execution needs exactly "${PAID_FLAG} ${MODEL_FLAG_PREFIX}<model> ${MAX_CALLS_FLAG}" and nothing else.` };
    }
    const model = models[0]!.slice(MODEL_FLAG_PREFIX.length);
    const entry = (EVAL_V3_MODELS as Record<string, { runnable: boolean; note: string }>)[model];
    if (!entry) return { mode: "error", message: `Refusing: "${model}" is not on the allow-list (${Object.keys(EVAL_V3_MODELS).join(", ")}).` };
    if (!entry.runnable) return { mode: "error", message: `Refusing: "${model}" is listed but not runnable yet: ${entry.note}.` };
    return { mode: "execute", model };
  }
  return { mode: "error", message: `Unknown arguments: ${argv.join(" ")}. Nothing was run. Use --help.` };
}

// -- plan (dry run: zero Bedrock calls) --------------------------------------------------------------------

const ALLOWED_SCENARIOS = new Set([
  "inc-104", "refund-dispute", "refund-dispute-custom", "stock-reconcile", "stock-reconcile-collab", "stock-reconcile-hostile", "payroll-check",
]);
const SECRET_SHAPES = /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.|Bearer\s+[A-Za-z0-9._-]{10,}|-----BEGIN|aws_secret_access_key/i;
const PRODUCTION_IDS = /ses_[0-9a-f]{32}|asg_[0-9a-f]{32}|sub_\d\d_[0-9a-f]{32}|northstar|canary-org-77|canary-sub-123|@[a-z0-9-]+\.[a-z]{2,}/i;

export interface Plan {
  bedrockCallsMade: 0;
  suiteVersion: string;
  suiteFingerprint: { actual: string; frozen: string; matches: boolean };
  requestsFingerprint: { actual: string; frozen: string; matches: boolean };
  caseCount: number;
  safetyCount: number;
  nonSafetyCount: number;
  cases: Array<{
    id: string; safety: boolean; originalDefect: boolean; dimensions: string[]; scenarioId: string; usesPublicInc104Fixture: boolean; historyTurns: number;
    requestChars: number; estInputTokens: number; requestSha256: string; hardChecks: number; reviewItems: number; followUp: string; structuralFailures: string[];
  }>;
  budget: { estInputTokensUpperBound: number; maxOutputTokensUpperBound: number; maxCallsPerModelRun: number };
  models: Array<{ id: string; runnable: boolean; note: string; worstCaseCostUsd: number | null; lockFile: string; paidCommand: string | null }>;
  inference: Record<string, string | number>;
  criteria: typeof SUITE_CRITERIA_V3;
  production: { casesReferencingProductionState: string[]; scenariosOutsideAllowList: string[] };
  credentials: { requestsWithSecretShapes: string[]; note: string };
}

export function buildPlan(): Plan {
  const reqs = EVAL_CASES_V3.map((c) => ({ c, built: buildEvalRequestV3(c) }));
  const b = usageBudgetV3();
  const sa = suiteFingerprintV3();
  const ra = requestsFingerprintV3();
  const text = (r: CoworkerRequest) => `${r.system}\n${r.messages.map((m) => m.text).join("\n")}`;
  return {
    bedrockCallsMade: 0,
    suiteVersion: SUITE_CRITERIA_V3.suiteVersion,
    suiteFingerprint: { actual: sa, frozen: FROZEN_SUITE_FINGERPRINT_V3, matches: sa === FROZEN_SUITE_FINGERPRINT_V3 },
    requestsFingerprint: { actual: ra, frozen: FROZEN_REQUESTS_FINGERPRINT_V3, matches: ra === FROZEN_REQUESTS_FINGERPRINT_V3 },
    caseCount: EVAL_CASES_V3.length,
    safetyCount: EVAL_CASES_V3.filter((c) => c.safety).length,
    nonSafetyCount: EVAL_CASES_V3.filter((c) => !c.safety).length,
    cases: reqs.map(({ c, built }, i) => ({
      id: c.id, safety: c.safety, originalDefect: c.originalDefect === true, dimensions: c.dimensions, scenarioId: c.scenario.content.scenarioId,
      usesPublicInc104Fixture: c.scenario === INC_104_V1, historyTurns: c.history.length, requestChars: b.perCase[i]!.requestChars,
      estInputTokens: b.perCase[i]!.estInputTokens, requestSha256: createHash("sha256").update(JSON.stringify(built.request)).digest("hex"),
      hardChecks: c.hard.length, reviewItems: c.review.length, followUp: built.followUp ? `${built.followUp.kind}${built.followUp.resolved ? "" : " (no referent)"}` : "-",
      structuralFailures: checkAssemblyV3(c, built),
    })),
    budget: { estInputTokensUpperBound: b.estInputTokensUpperBound, maxOutputTokensUpperBound: b.maxOutputTokensUpperBound, maxCallsPerModelRun: SUITE_CRITERIA_V3.maxCallsPerModelRun },
    models: Object.entries(EVAL_V3_MODELS).map(([id, m]) => ({
      id, runnable: m.runnable, note: m.note, worstCaseCostUsd: worstCaseCostUsd(id), lockFile: lockFileFor(id), paidCommand: m.runnable ? paidCommand(id) : null,
    })),
    inference: {
      region: EVAL_V3_REGION, api: "Bedrock Converse", maxOutputTokens: COWORKER_MAX_OUTPUT_TOKENS, temperature: COWORKER_TEMPERATURE,
      abortAfterMs: COWORKER_CALL_TIMEOUT_MS, sdkAttempts: 1, retries: 0, concurrency: 1, fallbackModel: "none", toolConfig: "none", guardrailConfig: "none", additionalModelRequestFields: "none",
      promptVersion: COWORKER_PROMPT_VERSION_V3,
    },
    criteria: SUITE_CRITERIA_V3,
    production: {
      casesReferencingProductionState: reqs.filter(({ built }) => PRODUCTION_IDS.test(text(built.request))).map(({ c }) => c.id),
      scenariosOutsideAllowList: EVAL_CASES_V3.filter((c) => !ALLOWED_SCENARIOS.has(c.scenario.content.scenarioId)).map((c) => c.id),
    },
    credentials: {
      requestsWithSecretShapes: reqs.filter(({ built }) => SECRET_SHAPES.test(text(built.request))).map(({ c }) => c.id),
      note: "The runner never reads or prints credentials, tokens or headers. Its output holds case ids, counts, request ids, the model's reply to synthetic prompts and automated results. Prompts are stored only as SHA-256. Provider errors are reduced to a fixed code.",
    },
  };
}

export function renderPlan(p: Plan): string {
  const L: string[] = [];
  L.push(`COWORKER v3 EVALUATION (${p.suiteVersion}): DRY RUN (zero Bedrock calls, zero AWS calls). NOT YET EXECUTED against any model.`);
  L.push(`Bedrock calls made: ${p.bedrockCallsMade}`);
  L.push("");
  L.push(`Cases: ${p.caseCount} (safety ${p.safetyCount}, non-safety ${p.nonSafetyCount})   Max model invocations per model run: ${p.budget.maxCallsPerModelRun} (one per case)`);
  L.push(`Suite fingerprint     ${p.suiteFingerprint.matches ? "MATCHES pinned" : "DOES NOT MATCH pinned"}  ${p.suiteFingerprint.actual}`);
  L.push(`Requests fingerprint  ${p.requestsFingerprint.matches ? "MATCHES pinned" : "DOES NOT MATCH pinned"}  ${p.requestsFingerprint.actual}`);
  L.push("");
  L.push("id                                class       defect scenario                  hist  estIn  follow-up");
  for (const c of p.cases) {
    L.push(`${c.id.padEnd(33)} ${(c.safety ? "SAFETY" : "non-safety").padEnd(11)} ${(c.originalDefect ? "yes" : "").padEnd(6)} ${c.scenarioId.padEnd(25)} ${String(c.historyTurns).padStart(4)} ${String(c.estInputTokens).padStart(6)}  ${c.followUp}${c.structuralFailures.length ? "  STRUCTURAL FAILURE" : ""}`);
  }
  L.push("");
  L.push(`Token budget per model run (upper bound): input ~${p.budget.estInputTokensUpperBound} (3 chars/token estimate), output at most ${p.budget.maxOutputTokensUpperBound}`);
  L.push("Inference: " + Object.entries(p.inference).map(([k, v]) => `${k}=${v}`).join("  "));
  L.push("");
  L.push("Models (listing is NOT authorization; every paid run needs its own written approval, one lock file per model):");
  for (const m of p.models) {
    L.push(`  ${m.id.padEnd(30)} ${(m.runnable ? "runnable" : "NOT RUNNABLE").padEnd(13)} worst-case $${m.worstCaseCostUsd === null ? "n/a" : m.worstCaseCostUsd.toFixed(4)}  lock=${m.lockFile}  (${m.note})`);
  }
  L.push("");
  L.push("Thresholds (fixed before any inference):");
  L.push(`  case passes: ${p.criteria.casePasses}`);
  L.push(`  all ${p.safetyCount} safety cases pass;  both original-defect cases (${p.criteria.originalDefectCasesMustPass.join(", ")}) pass;  non-safety: at least ${p.criteria.minNonSafetyPasses} of ${p.nonSafetyCount};  every reply complete`);
  L.push("  PASS requires an independent HUMAN review. An agent's judgement is labelled as such and cannot produce PASS.");
  L.push(`  on failure: ${p.criteria.onFail}`);
  L.push("");
  L.push(`Production state referenced by any case: ${p.production.casesReferencingProductionState.length === 0 ? "NONE" : p.production.casesReferencingProductionState.join(",")}`);
  L.push(`Scenarios outside the synthetic/public allow-list: ${p.production.scenariosOutsideAllowList.length === 0 ? "NONE" : p.production.scenariosOutsideAllowList.join(",")}`);
  L.push(`Requests containing credential/token shapes: ${p.credentials.requestsWithSecretShapes.length === 0 ? "NONE" : p.credentials.requestsWithSecretShapes.join(",")}`);
  L.push(`Credentials/logging: ${p.credentials.note}`);
  L.push("");
  L.push("Paid execution (NOT run by this command): npx tsx scripts/eval-coworker-v3.ts --execute-paid-bedrock-inference --model=<id> --max-calls=17");
  return L.join("\n");
}

// -- execution (the only code path that can call a model) --------------------------------------------------------

export interface CaseOutput extends LiveRecord {
  title: string;
  safety: boolean;
  originalDefect: boolean;
  dimensions: string[];
  requestSha256: string;
  requestChars: number;
  /** Layer 1: the provider call returned a usable reply (false for provider errors, timeouts, empty or filtered responses). */
  providerCompleted: boolean;
  providerRequestId: string | null;
  /** The raw model reply, kept for diagnosis. It is NOT necessarily what an employee would have seen: see employeeVisible and shownReply. */
  reply: string | null;
  stopReason: string | null;
  /** Layer 2: raw reply quality against the case heuristics and completeness (independent of the verifier). */
  rawFailures: string[];
  /** Layer 3: contradictions found by the platform fact verifier (the same disposeReply the chat route uses). */
  contradictions: string[];
  /** Layer 4: what production would do with this reply. Only ANSWER can count toward acceptance. */
  employeeVisible: EmployeeVisible;
  /** The text an employee would see (null when withheld or on error). Human reviewers judge THIS, not the raw reply. */
  shownReply: string | null;
  /** The employee received a whole answer: provider finished normally AND the reply was shown. */
  complete: boolean;
  wallMs: number;
  review: { status: "PENDING"; items: string[] };
}

export interface RunFile {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  complete: boolean;
  model: string;
  region: string;
  promptVersion: string;
  suiteVersion: string;
  suiteFingerprint: string;
  requestsFingerprint: string;
  inference: Plan["inference"];
  callsMade: number;
  cases: CaseOutput[];
  gate: GateV3 | null;
  stoppedEarly: string | null;
}

export interface ExecuteOptions {
  /** Repository root; output goes to <root>/eval-output/coworker-v3. */
  root: string;
  runId: string;
  model: string;
  env: Readonly<Record<string, string | undefined>>;
  makeProvider: () => EvalProvider;
  clock: () => number;
  out?: (line: string) => void;
}

export class CallBudget {
  private used = 0;
  private readonly seen = new Set<string>();
  take(id: string): void {
    if (this.seen.has(id)) throw new Error(`BUG: a second attempt for ${id} was requested; one attempt per case is a hard limit`);
    if (this.used >= SUITE_CRITERIA_V3.maxCallsPerModelRun) throw new Error("BUG: call cap reached");
    this.seen.add(id);
    this.used++;
  }
  get count(): number { return this.used; }
}

export function refuseUnsafeEnvironment(env: Readonly<Record<string, string | undefined>>, model: string): void {
  for (const k of ["AWS_REGION", "AWS_DEFAULT_REGION"]) {
    const v = env[k];
    if (v !== undefined && v !== "" && v !== EVAL_V3_REGION) throw new Error(`Refusing: ${k} is set to a region other than ${EVAL_V3_REGION}. The evaluation runs in ${EVAL_V3_REGION} only.`);
  }
  const m = env["ONBOARDOS_COWORKER_MODEL_ID"];
  if (m && m !== model) throw new Error("Refusing: ONBOARDOS_COWORKER_MODEL_ID disagrees with --model. The evaluation uses only the model named on the command line.");
}

export async function execute(o: ExecuteOptions): Promise<RunFile> {
  const say = o.out ?? (() => undefined);
  const entry = (EVAL_V3_MODELS as Record<string, { runnable: boolean; note: string }>)[o.model];
  if (!entry || !entry.runnable) throw new Error(`Refusing: "${o.model}" is not an allow-listed runnable model.`);
  refuseUnsafeEnvironment(o.env, o.model);

  const plan = buildPlan();
  if (!plan.suiteFingerprint.matches) throw new Error("Refusing: the evaluation cases or criteria differ from the pinned v3 suite.");
  if (!plan.requestsFingerprint.matches) throw new Error("Refusing: the requests built now differ from the pinned requests (edited prompt, fixture or stale build output). Run `npx tsc --build` and re-check, or re-pin deliberately.");
  if (plan.cases.some((c) => c.structuralFailures.length > 0)) throw new Error("Refusing: a request fails its structural checks.");
  if (plan.caseCount !== SUITE_CRITERIA_V3.maxCallsPerModelRun) throw new Error("Refusing: case count and call ceiling disagree.");
  if (plan.production.casesReferencingProductionState.length || plan.production.scenariosOutsideAllowList.length || plan.credentials.requestsWithSecretShapes.length) {
    throw new Error("Refusing: a request contains production identifiers, an unlisted scenario or credential-shaped text.");
  }

  const dir = join(o.root, OUT_DIR);
  const lockName = lockFileFor(o.model);
  const lock = join(dir, lockName);
  const already = `Refusing: ${join(OUT_DIR, lockName)} exists, so this model has already been evaluated with this suite. A rerun needs new approval; delete the file only then.`;
  if (existsSync(lock)) throw new Error(already); // checked before anything else is constructed

  const provider = o.makeProvider();
  if (provider.modelId !== o.model) throw new Error(`Refusing: provider model is ${provider.modelId}, expected ${o.model}.`);

  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(lock, `${o.runId}\n`, { flag: "wx" }); // exclusive create BEFORE the first call, so even a crash cannot allow a silent rerun
  } catch {
    throw new Error(already);
  }

  const runDir = join(dir, `${o.runId}-${lockName.replace(/^EXECUTED-|\.lock$/g, "")}`);
  mkdirSync(runDir, { recursive: true });
  const file: RunFile = {
    runId: o.runId, startedAt: new Date(o.clock()).toISOString(), finishedAt: null, complete: false, model: o.model, region: EVAL_V3_REGION,
    promptVersion: COWORKER_PROMPT_VERSION_V3, suiteVersion: SUITE_CRITERIA_V3.suiteVersion, suiteFingerprint: plan.suiteFingerprint.actual,
    requestsFingerprint: plan.requestsFingerprint.actual, inference: plan.inference, callsMade: 0, cases: [], gate: null, stoppedEarly: null,
  };
  const save = () => writeFileSync(join(runDir, "results.json"), JSON.stringify(file, null, 2));
  save();

  const budget = new CallBudget();
  for (const [i, c] of EVAL_CASES_V3.entries()) {
    const { request } = buildEvalRequestV3(c);
    const p = plan.cases[i]!;
    budget.take(c.id); // throws on a second attempt for the same case or beyond the ceiling
    const t0 = o.clock();
    let out: CaseOutput;
    const common = { title: c.title, safety: c.safety, originalDefect: c.originalDefect === true, dimensions: c.dimensions, requestSha256: p.requestSha256, requestChars: p.requestChars, review: { status: "PENDING" as const, items: c.review } };
    try {
      const reply = await provider.converse(request); // the ONE attempt; there is no retry anywhere in this file
      const r = evaluateReplyV3(c, reply.text, { stopReason: reply.stopReason, outputTokens: reply.outputTokens });
      out = {
        ...common, caseId: c.id, status: "COMPLETED", errorCode: null, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, latencyMs: reply.latencyMs,
        assemblyFailures: p.structuralFailures, hardFailures: r.hardFailures, providerCompleted: true, providerRequestId: reply.requestId, reply: reply.text, stopReason: reply.stopReason,
        rawFailures: r.rawFailures, contradictions: r.contradictions, employeeVisible: r.employeeVisible, shownReply: r.shownReply,
        complete: r.complete, wallMs: o.clock() - t0,
      };
    } catch (err) {
      const code = err instanceof CoworkerProviderError ? err.code : "AI_ERROR";
      out = {
        ...common, caseId: c.id, status: "ERROR", errorCode: code, inputTokens: null, outputTokens: null, latencyMs: null, assemblyFailures: p.structuralFailures,
        hardFailures: [`no reply: ${code}`], providerCompleted: false, providerRequestId: err instanceof CoworkerProviderError ? err.requestId : null, reply: null, stopReason: null,
        rawFailures: [], contradictions: [], employeeVisible: "ERROR_MESSAGE", shownReply: null,
        complete: false, wallMs: o.clock() - t0,
      };
    }
    file.cases.push(out);
    file.callsMade = budget.count;
    save();
    say(`${c.id.padEnd(33)} ${out.employeeVisible.padEnd(19)} in=${out.inputTokens ?? "-"} out=${out.outputTokens ?? "-"} ${out.latencyMs ?? "-"}ms automated=${out.hardFailures.length === 0 ? "pass" : `FAIL(${out.hardFailures.length})`}`);
    // A configuration problem (credentials, model access) cannot be fixed by asking again, so stop rather than send more requests.
    if (out.errorCode === "AI_UNAVAILABLE") {
      file.stoppedEarly = `Stopped after ${c.id}: AI_UNAVAILABLE (credentials, model access or region). No further requests were sent.`;
      break;
    }
  }

  file.finishedAt = new Date(o.clock()).toISOString();
  file.complete = file.cases.length === EVAL_CASES_V3.length;
  file.gate = buildGateV3(file.cases, null, null);
  save();
  const template: Record<string, unknown> = {
    _instructions: "Set _reviewer to \"human\" or \"agent\" (who judged). For each case set true only if the reader judged EVERY review item OK for the text in shownReply (what the employee would have seen; a case whose employeeVisible is not ANSWER can never pass), false otherwise, null if not yet reviewed. Only a \"human\" review can produce PASS. Then run: npx tsx scripts/eval-coworker-v3.ts --apply-review <results.json> <this file>",
    _reviewer: null,
  };
  for (const c of EVAL_CASES_V3) template[c.id] = null;
  writeFileSync(join(runDir, "review.json"), JSON.stringify(template, null, 2));
  return file;
}

// -- applying a review (zero Bedrock calls) ------------------------------------------------------------------------

export function applyReview(resultsPath: string, reviewPath: string): { gate: GateV3; outPath: string } {
  const run = JSON.parse(readFileSync(resultsPath, "utf8")) as RunFile;
  const raw = JSON.parse(readFileSync(reviewPath, "utf8")) as Record<string, unknown>;
  const review: Record<string, boolean | null> = {};
  for (const c of EVAL_CASES_V3) {
    const v = raw[c.id];
    review[c.id] = v === true ? true : v === false ? false : null;
  }
  const reviewer: ReviewerKind | null = raw["_reviewer"] === "human" ? "human" : raw["_reviewer"] === "agent" ? "agent" : null;
  if (Object.values(review).some((v) => v !== null) && reviewer === null) throw new Error('Refusing: the review file must say who judged: "_reviewer": "human" or "agent".');
  const gate = buildGateV3(run.cases, review, reviewer);
  const outPath = resultsPath.replace(/results\.json$/, "final-gate.json");
  if (outPath === resultsPath) throw new Error("results file must be named results.json");
  writeFileSync(outPath, JSON.stringify({ runId: run.runId, model: run.model, reviewer, appliedAt: "see file mtime", review, gate }, null, 2));
  return { gate, outPath };
}

export const rootHasGitignoreForOutput = (root: string): boolean =>
  existsSync(join(root, ".gitignore")) && readFileSync(join(root, ".gitignore"), "utf8").split("\n").some((l) => l.trim() === "eval-output/");

export function renderGate(g: GateV3): string {
  const L = ["RELEASE GATE (coworker v3)", `overall: ${g.overall}`, `review by: ${g.reviewer ?? "nobody yet"}${g.reviewer === "agent" ? " (AGENT JUDGEMENT, not a human review)" : ""}`];
  if (g.verdict) {
    L.push(`safety ${g.verdict.safetyPassed}/${g.verdict.safetyTotal}  original defects ${g.verdict.originalDefectsPassed}/${g.verdict.originalDefectsTotal}  non-safety ${g.verdict.nonSafetyPassed}/${g.verdict.nonSafetyTotal}  all replies complete: ${g.verdict.allComplete}`);
  }
  L.push(`automated: ${g.perCase.filter((c) => c.automatedPass).length}/${g.perCase.length}`);
  L.push(`employee-visible outcomes: answers=${g.outcomes.answers} truncated=${g.outcomes.truncatedAnswers} withheld(AI_UNVERIFIED, a safety interception, NOT an answer)=${g.outcomes.withheldUnverified} errors=${g.outcomes.errors}`);
  L.push(`usage: calls=${g.usage.calls} callsWithoutUsage=${g.usage.callsWithoutUsage} inputTokens=${g.usage.inputTokens} outputTokens=${g.usage.outputTokens} medianLatencyMs=${g.usage.medianLatencyMs} maxLatencyMs=${g.usage.maxLatencyMs}`);
  L.push("Not established by this evaluation:");
  for (const n of g.notEstablished) L.push(`  - ${n}`);
  return L.join("\n");
}
