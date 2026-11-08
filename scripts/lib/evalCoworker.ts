/**
 * Logic of the coworker-v2 live evaluation runner (scripts/eval-coworker.ts). Kept here so it is testable with a fake
 * provider and no network.
 *
 * HARD LIMITS, enforced in code (and tested):
 *   - nothing calls a model unless execute() is invoked, and the entry point only does that for
 *     `--execute-paid-bedrock-inference --max-calls=12`;
 *   - exactly one attempt per case: no retry, no second request after a failure, no concurrency, no fallback model;
 *   - a hard cap of 12 calls for the run, and an EXECUTED.lock that blocks any second run until a person deletes it;
 *   - the model and region are constants of the frozen suite; environment overrides are refused;
 *   - the evaluated requests must match the frozen fingerprints (so stale builds or edited prompts are refused).
 *
 * What it does NOT touch: OnboardOS API endpoints, Cognito, DynamoDB, CloudFormation, Vercel, the scenario runner
 * Lambda, any employee session. It authenticates as no employee. The only AWS call it can make is bedrock
 * Converse on the one frozen model, through the same provider the product uses.
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
import { COWORKER_PROMPT_VERSION } from "../../services/api/src/coworkerContext.js";
import {
  EVAL_CASES,
  EVAL_MODEL_ID,
  EVAL_REGION,
  FROZEN_REQUESTS_FINGERPRINT,
  FROZEN_SUITE_FINGERPRINT,
  SUITE_CRITERIA,
  buildEvalRequest,
  buildGate,
  checkAssembly,
  evaluateReply,
  requestsFingerprint,
  suiteFingerprint,
  usageBudget,
  type Gate,
  type LiveRecord,
} from "../../services/api/src/evals/coworkerEval.js";
import { INC_104_V1 } from "@onboardos/scenario-fixtures";

export const PAID_FLAG = "--execute-paid-bedrock-inference";
export const MAX_CALLS_FLAG = `--max-calls=${SUITE_CRITERIA.maxTotalCalls}`;
export const PAID_COMMAND = `npx tsx scripts/eval-coworker.ts ${PAID_FLAG} ${MAX_CALLS_FLAG}`;
export const OUT_DIR = "eval-output/coworker-v2";
export const LOCK_FILE = "EXECUTED.lock";

export interface EvalProvider {
  readonly modelId: string;
  converse(request: CoworkerRequest): Promise<CoworkerReply>;
}

// -- arguments --------------------------------------------------------------------------------------

export type Command =
  | { mode: "dry-run" }
  | { mode: "help" }
  | { mode: "execute" }
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
    if (rest.length === 1 && rest[0] === MAX_CALLS_FLAG) return { mode: "execute" };
    return { mode: "error", message: `Refusing: paid execution needs exactly "${PAID_FLAG} ${MAX_CALLS_FLAG}" and nothing else.` };
  }
  return { mode: "error", message: `Unknown arguments: ${argv.join(" ")}. Nothing was run. Use --help.` };
}

// -- plan (dry run: zero Bedrock calls) --------------------------------------------------------------------

const ALLOWED_SCENARIOS = new Set(["inc-104", "refund-dispute", "stock-reconcile", "stock-reconcile-collab", "stock-reconcile-hostile"]);
const SECRET_SHAPES = /AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.|Bearer\s+[A-Za-z0-9._-]{10,}|-----BEGIN|aws_secret_access_key/i;
const PRODUCTION_IDS = /ses_[0-9a-f]{32}|asg_[0-9a-f]{32}|sub_\d\d_[0-9a-f]{32}|northstar|canary-org-77|canary-sub-123|@[a-z0-9-]+\.[a-z]{2,}/i;

export interface Plan {
  bedrockCallsMade: 0;
  suiteFingerprint: { actual: string; frozen: string; matches: boolean };
  requestsFingerprint: { actual: string; frozen: string; matches: boolean };
  caseCount: number;
  safetyCount: number;
  nonSafetyCount: number;
  cases: Array<{
    id: string; safety: boolean; dimensions: string[]; scenarioId: string; usesPublicInc104Fixture: boolean; historyTurns: number;
    requestChars: number; estInputTokens: number; requestSha256: string; hardChecks: number; reviewItems: number; structuralFailures: string[];
  }>;
  budget: { estInputTokensUpperBound: number; maxOutputTokensUpperBound: number; maxCalls: number };
  inference: Record<string, string | number>;
  criteria: typeof SUITE_CRITERIA;
  production: { casesReferencingProductionState: string[]; scenariosOutsideAllowList: string[]; requestsWithProductionIdentifiers: string[] };
  credentials: { requestsWithSecretShapes: string[]; note: string };
  paidCommand: string;
}

export function buildPlan(): Plan {
  const reqs = EVAL_CASES.map((c) => ({ c, r: buildEvalRequest(c) }));
  const b = usageBudget();
  const sa = suiteFingerprint();
  const ra = requestsFingerprint();
  const text = (r: CoworkerRequest) => `${r.system}\n${r.messages.map((m) => m.text).join("\n")}`;
  return {
    bedrockCallsMade: 0,
    suiteFingerprint: { actual: sa, frozen: FROZEN_SUITE_FINGERPRINT, matches: sa === FROZEN_SUITE_FINGERPRINT },
    requestsFingerprint: { actual: ra, frozen: FROZEN_REQUESTS_FINGERPRINT, matches: ra === FROZEN_REQUESTS_FINGERPRINT },
    caseCount: EVAL_CASES.length,
    safetyCount: EVAL_CASES.filter((c) => c.safety).length,
    nonSafetyCount: EVAL_CASES.filter((c) => !c.safety).length,
    cases: reqs.map(({ c, r }, i) => ({
      id: c.id, safety: c.safety, dimensions: c.dimensions, scenarioId: c.scenario.content.scenarioId, usesPublicInc104Fixture: c.scenario === INC_104_V1,
      historyTurns: c.history.length, requestChars: b.perCase[i]!.requestChars, estInputTokens: b.perCase[i]!.estInputTokens,
      requestSha256: createHash("sha256").update(JSON.stringify(r)).digest("hex"), hardChecks: c.hard.length, reviewItems: c.review.length,
      structuralFailures: checkAssembly(c, r),
    })),
    budget: { estInputTokensUpperBound: b.estInputTokensUpperBound, maxOutputTokensUpperBound: b.maxOutputTokensUpperBound, maxCalls: SUITE_CRITERIA.maxTotalCalls },
    inference: {
      modelId: EVAL_MODEL_ID, region: EVAL_REGION, api: "Bedrock Converse", maxOutputTokens: COWORKER_MAX_OUTPUT_TOKENS, temperature: COWORKER_TEMPERATURE,
      abortAfterMs: COWORKER_CALL_TIMEOUT_MS, sdkAttempts: 1, retries: 0, concurrency: 1, fallbackModel: "none", toolConfig: "none", guardrailConfig: "none", promptVersion: COWORKER_PROMPT_VERSION,
    },
    criteria: SUITE_CRITERIA,
    production: {
      casesReferencingProductionState: reqs.filter(({ r }) => PRODUCTION_IDS.test(text(r))).map(({ c }) => c.id),
      scenariosOutsideAllowList: EVAL_CASES.filter((c) => !ALLOWED_SCENARIOS.has(c.scenario.content.scenarioId)).map((c) => c.id),
      requestsWithProductionIdentifiers: reqs.filter(({ r }) => PRODUCTION_IDS.test(text(r))).map(({ c }) => c.id),
    },
    credentials: {
      requestsWithSecretShapes: reqs.filter(({ r }) => SECRET_SHAPES.test(text(r))).map(({ c }) => c.id),
      note: "The runner never reads or prints credentials, tokens or headers. Its output holds case ids, counts, request ids, the model's reply to synthetic prompts and heuristic results. Prompts are stored only as SHA-256. Provider errors are reduced to a fixed code.",
    },
    paidCommand: PAID_COMMAND,
  };
}

export function renderPlan(p: Plan): string {
  const L: string[] = [];
  L.push("COWORKER v2 LIVE EVALUATION: DRY RUN (zero Bedrock calls, zero AWS calls)");
  L.push(`Bedrock calls made: ${p.bedrockCallsMade}`);
  L.push("");
  L.push(`Cases: ${p.caseCount} (safety ${p.safetyCount}, non-safety ${p.nonSafetyCount})   Max model invocations: ${p.budget.maxCalls} (one per case)`);
  L.push(`Suite fingerprint     ${p.suiteFingerprint.matches ? "MATCHES frozen" : "DOES NOT MATCH frozen"}  ${p.suiteFingerprint.actual}`);
  L.push(`Requests fingerprint  ${p.requestsFingerprint.matches ? "MATCHES frozen" : "DOES NOT MATCH frozen"}  ${p.requestsFingerprint.actual}`);
  L.push("");
  L.push("id                          class       scenario                  hist  estIn  dims");
  for (const c of p.cases) {
    L.push(`${c.id.padEnd(27)} ${(c.safety ? "SAFETY" : "non-safety").padEnd(11)} ${c.scenarioId.padEnd(25)} ${String(c.historyTurns).padStart(4)} ${String(c.estInputTokens).padStart(6)}  ${c.dimensions.join(",")}${c.structuralFailures.length ? "  STRUCTURAL FAILURE" : ""}`);
  }
  L.push("");
  L.push(`Token budget (upper bound): input ~${p.budget.estInputTokensUpperBound} (3 chars/token estimate), output at most ${p.budget.maxOutputTokensUpperBound} (12 x ${p.inference["maxOutputTokens"]})`);
  L.push("Inference: " + Object.entries(p.inference).map(([k, v]) => `${k}=${v}`).join("  "));
  L.push("");
  L.push("Pass/fail (frozen):");
  L.push(`  case passes: ${p.criteria.casePasses}`);
  L.push(`  safety cases: all ${p.safetyCount} must pass;  non-safety: at least ${p.criteria.minNonSafetyPasses} of ${p.nonSafetyCount};  human review required for any PASS`);
  L.push(`  on failure: ${p.criteria.onFail}`);
  L.push("");
  L.push(`Production state referenced by any case: ${p.production.casesReferencingProductionState.length === 0 ? "NONE" : p.production.casesReferencingProductionState.join(",")}`);
  L.push(`Scenarios outside the synthetic/public allow-list: ${p.production.scenariosOutsideAllowList.length === 0 ? "NONE" : p.production.scenariosOutsideAllowList.join(",")}`);
  L.push(`Cases using the public INC-104 fixture: ${p.cases.filter((c) => c.usesPublicInc104Fixture).map((c) => c.id).join(", ")}`);
  L.push(`Requests containing credential/token shapes: ${p.credentials.requestsWithSecretShapes.length === 0 ? "NONE" : p.credentials.requestsWithSecretShapes.join(",")}`);
  L.push(`Credentials/logging: ${p.credentials.note}`);
  L.push("");
  L.push(`Paid execution (NOT run by this command): ${p.paidCommand}`);
  return L.join("\n");
}

// -- execution (the only code path that can call a model) --------------------------------------------------------

export interface CaseOutput extends LiveRecord {
  title: string;
  safety: boolean;
  dimensions: string[];
  requestSha256: string;
  requestChars: number;
  providerRequestId: string | null;
  reply: string | null;
  stopReason: string | null;
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
  suiteFingerprint: string;
  requestsFingerprint: string;
  inference: Plan["inference"];
  callsMade: number;
  cases: CaseOutput[];
  gate: Gate | null;
  stoppedEarly: string | null;
}

export interface ExecuteOptions {
  /** Repository root; output goes to <root>/eval-output/coworker-v2. */
  root: string;
  runId: string;
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
    if (this.used >= SUITE_CRITERIA.maxTotalCalls) throw new Error("BUG: call cap reached");
    this.seen.add(id);
    this.used++;
  }
  get count(): number { return this.used; }
}

export function refuseUnsafeEnvironment(env: Readonly<Record<string, string | undefined>>): void {
  for (const k of ["AWS_REGION", "AWS_DEFAULT_REGION"]) {
    const v = env[k];
    if (v !== undefined && v !== "" && v !== EVAL_REGION) throw new Error(`Refusing: ${k} is set to a region other than ${EVAL_REGION}. The evaluation is frozen to ${EVAL_REGION}.`);
  }
  if (env["ONBOARDOS_COWORKER_MODEL_ID"] && env["ONBOARDOS_COWORKER_MODEL_ID"] !== EVAL_MODEL_ID) {
    throw new Error("Refusing: ONBOARDOS_COWORKER_MODEL_ID is set to a different model. The evaluation is frozen to its model and ignores this variable.");
  }
}

export async function execute(o: ExecuteOptions): Promise<RunFile> {
  const say = o.out ?? (() => undefined);
  refuseUnsafeEnvironment(o.env);

  const plan = buildPlan();
  if (!plan.suiteFingerprint.matches) throw new Error("Refusing: the evaluation cases or criteria differ from the frozen suite.");
  if (!plan.requestsFingerprint.matches) throw new Error("Refusing: the requests built now differ from the frozen requests (edited prompt, fixture or stale build output). Run `npx tsc --build` and re-check, or re-freeze deliberately.");
  if (plan.cases.some((c) => c.structuralFailures.length > 0)) throw new Error("Refusing: a request fails its structural checks.");
  if (plan.caseCount !== SUITE_CRITERIA.maxTotalCalls) throw new Error("Refusing: case count and call cap disagree.");
  if (plan.production.casesReferencingProductionState.length || plan.credentials.requestsWithSecretShapes.length) throw new Error("Refusing: a request contains production identifiers or credential-shaped text.");

  const dir = join(o.root, OUT_DIR);
  const lock = join(dir, LOCK_FILE);
  const already = `Refusing: ${join(OUT_DIR, LOCK_FILE)} exists, so this evaluation has already been executed. A rerun needs new approval; delete the file only then.`;
  if (existsSync(lock)) throw new Error(already); // checked before anything else is constructed

  const provider = o.makeProvider();
  if (provider.modelId !== EVAL_MODEL_ID) throw new Error(`Refusing: provider model is ${provider.modelId}, expected ${EVAL_MODEL_ID}.`);

  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(lock, `${o.runId}\n`, { flag: "wx" }); // exclusive create BEFORE the first call, so even a crash cannot allow a silent rerun
  } catch {
    throw new Error(already);
  }

  const runDir = join(dir, o.runId);
  mkdirSync(runDir, { recursive: true });
  const file: RunFile = {
    runId: o.runId, startedAt: new Date(o.clock()).toISOString(), finishedAt: null, complete: false, model: EVAL_MODEL_ID, region: EVAL_REGION,
    promptVersion: COWORKER_PROMPT_VERSION, suiteFingerprint: plan.suiteFingerprint.actual, requestsFingerprint: plan.requestsFingerprint.actual,
    inference: plan.inference, callsMade: 0, cases: [], gate: null, stoppedEarly: null,
  };
  const save = () => writeFileSync(join(runDir, "results.json"), JSON.stringify(file, null, 2));
  save();

  const budget = new CallBudget();
  for (const [i, c] of EVAL_CASES.entries()) {
    const request = buildEvalRequest(c);
    const p = plan.cases[i]!;
    budget.take(c.id); // throws on a second attempt for the same case or beyond the cap
    const t0 = o.clock();
    let out: CaseOutput;
    try {
      const reply = await provider.converse(request); // the ONE attempt; there is no retry anywhere in this file
      const r = evaluateReply(c, reply.text, { stopReason: reply.stopReason, outputTokens: reply.outputTokens });
      out = {
        caseId: c.id, status: "COMPLETED", errorCode: null, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, latencyMs: reply.latencyMs,
        assemblyFailures: p.structuralFailures, hardFailures: r.hardFailures, title: c.title, safety: c.safety, dimensions: c.dimensions,
        requestSha256: p.requestSha256, requestChars: p.requestChars, providerRequestId: reply.requestId, reply: reply.text, stopReason: reply.stopReason,
        complete: r.complete, wallMs: o.clock() - t0, review: { status: "PENDING", items: c.review },
      };
    } catch (err) {
      const code = err instanceof CoworkerProviderError ? err.code : "AI_ERROR";
      out = {
        caseId: c.id, status: "ERROR", errorCode: code, inputTokens: null, outputTokens: null, latencyMs: null, assemblyFailures: p.structuralFailures,
        hardFailures: [`no reply: ${code}`], title: c.title, safety: c.safety, dimensions: c.dimensions, requestSha256: p.requestSha256,
        requestChars: p.requestChars, providerRequestId: err instanceof CoworkerProviderError ? err.requestId : null, reply: null, stopReason: null,
        complete: false, wallMs: o.clock() - t0, review: { status: "PENDING", items: c.review },
      };
    }
    file.cases.push(out);
    file.callsMade = budget.count;
    save();
    say(`${c.id.padEnd(27)} ${out.status.padEnd(9)} in=${out.inputTokens ?? "-"} out=${out.outputTokens ?? "-"} ${out.latencyMs ?? "-"}ms automated=${out.hardFailures.length === 0 ? "pass" : `FAIL(${out.hardFailures.length})`}`);
    // A configuration problem (credentials, model access) cannot be fixed by asking again, so stop rather than send more requests.
    if (out.errorCode === "AI_UNAVAILABLE") {
      file.stoppedEarly = `Stopped after ${c.id}: AI_UNAVAILABLE (credentials, model access or region). No further requests were sent.`;
      break;
    }
  }

  file.finishedAt = new Date(o.clock()).toISOString();
  file.complete = file.cases.length === EVAL_CASES.length;
  file.gate = buildGate(file.cases, null);
  save();
  const template: Record<string, unknown> = { _instructions: "Set each case to true only if a human reader judged EVERY review item OK for that case, false otherwise. Leave null if not yet reviewed. Then run: npx tsx scripts/eval-coworker.ts --apply-review <results.json> <this file>" };
  for (const c of EVAL_CASES) template[c.id] = null;
  writeFileSync(join(runDir, "review.json"), JSON.stringify(template, null, 2));
  return file;
}

// -- applying a human review (zero Bedrock calls) ------------------------------------------------------------------------

export function applyReview(resultsPath: string, reviewPath: string): { gate: Gate; outPath: string } {
  const run = JSON.parse(readFileSync(resultsPath, "utf8")) as RunFile;
  const raw = JSON.parse(readFileSync(reviewPath, "utf8")) as Record<string, unknown>;
  const review: Record<string, boolean | null> = {};
  for (const c of EVAL_CASES) {
    const v = raw[c.id];
    review[c.id] = v === true ? true : v === false ? false : null;
  }
  const gate = buildGate(run.cases, review);
  const outPath = resultsPath.replace(/results\.json$/, "final-gate.json");
  if (outPath === resultsPath) throw new Error("results file must be named results.json");
  writeFileSync(outPath, JSON.stringify({ runId: run.runId, appliedAt: "see file mtime", review, gate }, null, 2));
  return { gate, outPath };
}

export const rootHasGitignoreForOutput = (root: string): boolean =>
  existsSync(join(root, ".gitignore")) && readFileSync(join(root, ".gitignore"), "utf8").split("\n").some((l) => l.trim() === "eval-output/");

export function renderGate(g: Gate): string {
  const L = ["RELEASE GATE", `overall: ${g.overall}`];
  L.push(`A prompt construction (structural only): ${g.A_promptConstruction.passed}/${g.A_promptConstruction.total}`);
  for (const [d, v] of Object.entries(g.dimensions)) L.push(`${d.padEnd(14)} automated ${v.automatedPassed}/${v.cases.length}  human-reviewed ${v.humanReviewed}/${v.cases.length}  ${v.status}`);
  L.push(`G usage: calls=${g.G_usage.calls} inputTokens=${g.G_usage.inputTokens} outputTokens=${g.G_usage.outputTokens} medianLatencyMs=${g.G_usage.medianLatencyMs} maxLatencyMs=${g.G_usage.maxLatencyMs}`);
  L.push("Not established by this evaluation:");
  for (const n of g.notEstablished) L.push(`  - ${n}`);
  return L.join("\n");
}
