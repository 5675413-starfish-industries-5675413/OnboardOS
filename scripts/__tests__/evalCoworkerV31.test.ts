/**
 * The v3.1 evaluation runner, tested with a FAKE provider. Nothing here calls AWS or any model.
 * Guard rails: dry run is inert, explicit allow-listed model, one attempt per MODEL case, platform-answered cases make no call, no
 * retry, no concurrency, per-model lock in its own directory, v2 and v3 outputs and locks untouched, honest gate.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoworkerProviderError, createBedrockClient, type CoworkerReply, type CoworkerRequest } from "../../services/api/src/bedrock.js";
import { CANNED_V31 } from "../../services/api/src/evals/cannedRepliesV31.js";
import { EVAL_CASES_V31, EVAL_V31_REGION, MODEL_CASES_V31, SUITE_CRITERIA_V31 } from "../../services/api/src/evals/coworkerEvalV31.js";
import { PLATFORM_CLARIFICATION } from "../../services/api/src/followUp.js";
import {
  CallBudget, MAX_CALLS_FLAG, OUT_DIR, PAID_FLAG, applyReview, buildPlan, execute, lockFileFor, paidCommand, parseArgs, refuseUnsafeEnvironment,
  renderGate, renderPlan, rootHasGitignoreForOutput, type EvalProvider,
} from "../lib/evalCoworkerV31.js";

const MICRO = "amazon.nova-micro-v1:0";
const LITE = "amazon.nova-lite-v1:0";
const PRO = "amazon.nova-pro-v1:0";

const reply = (text: string, modelId = MICRO, over: Partial<CoworkerReply> = {}): CoworkerReply => ({
  text, modelId, inputTokens: 2500, outputTokens: 120, requestId: "req-x", stopReason: "end_turn", latencyMs: 400, truncated: false, ...over,
});

class FakeProvider implements EvalProvider {
  calls: Array<{ id: string; request: CoworkerRequest }> = [];
  inFlight = 0;
  maxInFlight = 0;
  lockSeenBeforeFirstCall: boolean | null = null;
  constructor(private readonly root: string, private readonly behave: (i: number) => CoworkerReply | Error, readonly modelId = MICRO) {}
  async converse(request: CoworkerRequest): Promise<CoworkerReply> {
    const i = this.calls.length;
    if (i === 0) this.lockSeenBeforeFirstCall = existsSync(join(this.root, OUT_DIR, lockFileFor(this.modelId)));
    this.calls.push({ id: MODEL_CASES_V31[i]!.id, request });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await Promise.resolve();
    this.inFlight--;
    const r = this.behave(i);
    if (r instanceof Error) throw r;
    return r;
  }
}

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "eval-coworker-v31-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const good = (i: number) => reply(CANNED_V31[MODEL_CASES_V31[i]!.id]!.good);
const run = (provider: FakeProvider, env: Record<string, string | undefined> = {}, model = provider.modelId, runId = "run-1") =>
  execute({ root, runId, model, env, makeProvider: () => provider, clock: (() => { let t = 1_000; return () => (t += 10); })() });
const runDirOf = (model = MICRO) => join(root, OUT_DIR, readdirSync(join(root, OUT_DIR)).find((d) => d.startsWith("run-1-") && d.endsWith(lockFileFor(model).replace(/^EXECUTED-|\.lock$/g, "")))!);
const idxOf = (id: string) => MODEL_CASES_V31.findIndex((c) => c.id === id);

describe("arguments: nothing paid runs by accident", () => {
  it("no arguments and --dry-run are the same inert dry run", () => {
    expect(parseArgs([])).toEqual({ mode: "dry-run" });
    expect(parseArgs(["--dry-run"])).toEqual({ mode: "dry-run" });
  });

  it("paid execution needs the paid flag, one allow-listed model and the exact ceiling of 26", () => {
    expect(MAX_CALLS_FLAG).toBe("--max-calls=26");
    expect(parseArgs([PAID_FLAG, `--model=${MICRO}`, MAX_CALLS_FLAG])).toEqual({ mode: "execute", model: MICRO });
    for (const b of [
      [PAID_FLAG], [PAID_FLAG, MAX_CALLS_FLAG], [PAID_FLAG, `--model=${MICRO}`], [PAID_FLAG, `--model=${MICRO}`, "--max-calls=17"], [PAID_FLAG, `--model=${MICRO}`, "--max-calls=27"],
      [PAID_FLAG, `--model=${MICRO}`, MAX_CALLS_FLAG, "--retries=3"], [PAID_FLAG, `--model=${MICRO}`, `--model=${LITE}`, MAX_CALLS_FLAG], [PAID_FLAG, "--model=anthropic.claude-3-haiku", MAX_CALLS_FLAG],
      [`--model=${MICRO}`, MAX_CALLS_FLAG], ["--execute"], ["--all-models"],
    ]) expect(parseArgs(b).mode, b.join(" ")).toBe("error");
    expect((parseArgs([PAID_FLAG, "--model=us.amazon.nova-2-lite-v1:0", MAX_CALLS_FLAG]) as { message: string }).message).toMatch(/not runnable/);
  });

  it("has its own entry point, output directory and lock names (different from v2 and v3)", () => {
    expect(OUT_DIR).toBe("eval-output/coworker-v3.1");
    expect(lockFileFor(MICRO)).toBe("EXECUTED-amazon.nova-micro-v1_0.lock");
    expect(paidCommand(LITE)).toBe(`npx tsx scripts/eval-coworker-v31.ts --execute-paid-bedrock-inference --model=${LITE} --max-calls=26`);
    expect(SUITE_CRITERIA_V31.maxCallsPerModelRun).toBe(MODEL_CASES_V31.length);
  });
});

describe("dry run: a plan, zero calls", () => {
  it("reports the pinned suite and makes no Bedrock call", () => {
    const p = buildPlan();
    expect(p.bedrockCallsMade).toBe(0);
    expect(p).toMatchObject({ caseCount: 29, modelCaseCount: 26, deterministicCount: 3, criticalCount: 11, generalCount: 15 });
    expect(p.suiteFingerprint.matches).toBe(true);
    expect(p.requestsFingerprint.matches).toBe(true);
    expect(p.cases.every((c) => c.structuralFailures.length === 0)).toBe(true);
    expect(p.budget).toMatchObject({ maxCallsPerModelRun: 26, maxOutputTokensUpperBound: 26 * 400 });
    expect(p.inference).toMatchObject({ region: "us-east-1", maxOutputTokens: 400, temperature: 0.3, sdkAttempts: 1, retries: 0, concurrency: 1, fallbackModel: "none", toolConfig: "none", additionalModelRequestFields: "none", promptVersion: "coworker-v3.1" });
    expect(p.cases.filter((c) => c.deterministic).map((c) => c.estInputTokens)).toEqual([0, 0, 0]);
  });

  it("references no production state, no unlisted scenario and no credential-shaped text", () => {
    const p = buildPlan();
    expect(p.production).toEqual({ casesReferencingProductionState: [], scenariosOutsideAllowList: [] });
    expect(p.credentials.requestsWithSecretShapes).toEqual([]);
  });

  it("renders thresholds, models and the paid command shape without printing prompt text", () => {
    const text = renderPlan(buildPlan());
    expect(text).toContain("Bedrock calls made: 0");
    expect(text).toContain("NOT YET EXECUTED");
    expect(text).toContain("26 answered by a model, 3 by the platform");
    expect(text).toContain("at least 13 of 15");
    expect(text).toContain("HUMAN review");
    expect(text).not.toContain("You are \"Coworker\"");
    expect(text).not.toContain("<<<SCENARIO");
  });

  it("its source constructs a provider only in the paid branch, reaches nothing in production, and never touches v2/v3 outputs", () => {
    const entry = readFileSync(join(__dirname, "..", "eval-coworker-v31.ts"), "utf8");
    const lib = readFileSync(join(__dirname, "..", "lib", "evalCoworkerV31.ts"), "utf8");
    expect(entry.match(/new BedrockConverseProvider/g)).toHaveLength(1);
    expect(entry.indexOf("new BedrockConverseProvider")).toBeGreaterThan(entry.indexOf('case "execute"'));
    for (const src of [entry, lib]) {
      const imports = [...src.matchAll(/^import[^;]*from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
      for (const i of imports) expect(i).not.toMatch(/cognito|dynamodb|cloudformation|client-lambda|client-sts|client-iam|routes\/|\/deps|\/repo|\/authz|\/auth\.js|test-runner/);
      expect(src).not.toMatch(/\bfetch\(|InvokeCommand|process\.env\[?\.?["']?(AWS_SECRET|AWS_SESSION|AWS_ACCESS)/);
    }
    expect(lib).not.toMatch(/eval-output\/coworker-v2|coworker-v3\/|EXECUTED\.lock|lib\/evalCoworker\.js|lib\/evalCoworkerV3\.js/);
  });

  it("the bedrock client it would use makes a single SDK attempt", async () => {
    expect(await createBedrockClient(EVAL_V31_REGION).config.maxAttempts()).toBe(1);
  });
});

describe("execution: one attempt per MODEL case; the platform answers the rest", () => {
  it("makes exactly 26 sequential model calls in case order, never concurrent, and none for the 3 platform cases", async () => {
    const p = new FakeProvider(root, good);
    const r = await run(p);
    expect(p.calls.map((c) => c.id)).toEqual(MODEL_CASES_V31.map((c) => c.id));
    expect(p.calls).toHaveLength(26);
    expect(p.maxInFlight).toBe(1);
    expect(r.callsMade).toBe(26);
    expect(r.cases).toHaveLength(29);
    expect(r.complete).toBe(true);
    for (const id of ["F05-simplify-no-referent", "G11-why-no-referent", "G12-explain-again-no-referent"]) {
      expect(p.calls.some((c) => c.id === id)).toBe(false);
      expect(r.cases.find((c) => c.caseId === id)).toMatchObject({ deterministic: true, providerCompleted: null, employeeVisible: "PLATFORM_CLARIFICATION", shownReply: PLATFORM_CLARIFICATION, reply: null, hardFailures: [], inputTokens: 0, outputTokens: 0 });
    }
  });

  it("sends the real pinned v3.1 requests", async () => {
    const p = new FakeProvider(root, good);
    await run(p);
    for (const [i, c] of MODEL_CASES_V31.entries()) {
      expect(p.calls[i]!.request.messages.at(-1)!.text).toContain(c.message.trim());
      expect(p.calls[i]!.request.system).toContain("prompt coworker-v3.1");
    }
  });

  it("a failed call is NOT retried: one attempt, the run continues", async () => {
    for (const code of ["AI_TIMEOUT", "AI_THROTTLED", "AI_ERROR", "AI_BAD_RESPONSE", "AI_EMPTY_RESPONSE", "AI_FILTERED"] as const) {
      rmSync(join(root, OUT_DIR), { recursive: true, force: true });
      const p = new FakeProvider(root, (i) => (i === 2 ? new CoworkerProviderError(code, "rid-9") : good(i)));
      const r = await run(p);
      expect(p.calls, code).toHaveLength(26);
      expect(p.calls.filter((c) => c.id === MODEL_CASES_V31[2]!.id), code).toHaveLength(1);
      expect(r.cases.find((c) => c.caseId === MODEL_CASES_V31[2]!.id)).toMatchObject({ status: "ERROR", errorCode: code, providerCompleted: false, employeeVisible: "ERROR_MESSAGE", reply: null });
      expect(r.gate!.overall).toBe("AUTOMATED_FAIL");
    }
  });

  it("an unexpected exception is recorded as AI_ERROR without leaking its message", async () => {
    const p = new FakeProvider(root, (i) => (i === 0 ? new Error("secret-token-abc leaked") : good(i)));
    const r = await run(p);
    expect(r.cases[0]).toMatchObject({ status: "ERROR", errorCode: "AI_ERROR" });
    expect(readFileSync(join(runDirOf(), "results.json"), "utf8")).not.toContain("secret-token-abc");
  });

  it("AI_UNAVAILABLE stops the run after that one attempt", async () => {
    const p = new FakeProvider(root, () => new CoworkerProviderError("AI_UNAVAILABLE"));
    const r = await run(p);
    expect(p.calls).toHaveLength(1);
    expect(r.complete).toBe(false);
    expect(r.stoppedEarly).toMatch(/AI_UNAVAILABLE/);
  });

  it("the call budget refuses a second attempt for a case and any call beyond 26", () => {
    const b = new CallBudget();
    b.take("a");
    expect(() => b.take("a")).toThrow(/second attempt/);
    for (let i = 0; i < 25; i++) b.take(`c${i}`);
    expect(() => b.take("one-too-many")).toThrow(/cap/);
    expect(b.count).toBe(26);
  });
});

describe("locks, directories, model and region", () => {
  it("creates the lock BEFORE the first call and refuses a rerun without constructing a provider", async () => {
    const p = new FakeProvider(root, good);
    await run(p);
    expect(p.lockSeenBeforeFirstCall).toBe(true);
    let constructed = 0;
    await expect(execute({ root, runId: "run-2", model: MICRO, env: {}, makeProvider: () => { constructed++; return new FakeProvider(root, good); }, clock: () => 1 })).rejects.toThrow(/already been evaluated/);
    expect(constructed).toBe(0);
  });

  it("another model has its own lock and ceiling of 26", async () => {
    await run(new FakeProvider(root, good));
    const lite = new FakeProvider(root, (i) => reply(CANNED_V31[MODEL_CASES_V31[i]!.id]!.good, LITE), LITE);
    await run(lite, {}, LITE, "run-2");
    expect(lite.calls).toHaveLength(26);
    expect(readdirSync(join(root, OUT_DIR)).filter((f) => f.endsWith(".lock")).sort()).toEqual([lockFileFor(LITE), lockFileFor(MICRO)].sort());
  });

  it("existing v2 and v3 locks and results neither block nor are modified", async () => {
    for (const [dir, lock] of [["coworker-v2", "EXECUTED.lock"], ["coworker-v3", lockFileFor(MICRO)]] as const) {
      mkdirSync(join(root, "eval-output", dir), { recursive: true });
      writeFileSync(join(root, "eval-output", dir, lock), "earlier-run\n");
      writeFileSync(join(root, "eval-output", dir, "results.json"), "{\"frozen\":true}");
    }
    await run(new FakeProvider(root, good));
    for (const [dir, lock] of [["coworker-v2", "EXECUTED.lock"], ["coworker-v3", lockFileFor(MICRO)]] as const) {
      expect(readFileSync(join(root, "eval-output", dir, lock), "utf8")).toBe("earlier-run\n");
      expect(readFileSync(join(root, "eval-output", dir, "results.json"), "utf8")).toBe("{\"frozen\":true}");
      expect(readdirSync(join(root, "eval-output", dir)).sort()).toEqual([lock, "results.json"].sort());
    }
  });

  it("refuses a non-allow-listed model, a different region, or a disagreeing model variable before any call or lock", async () => {
    for (const model of ["anthropic.claude-3-haiku", "us.amazon.nova-2-lite-v1:0", ""]) {
      const p = new FakeProvider(root, good, model);
      await expect(run(p, {}, model)).rejects.toThrow(/Refusing/);
      expect(p.calls).toHaveLength(0);
    }
    for (const env of [{ AWS_REGION: "eu-west-1" }, { AWS_DEFAULT_REGION: "us-west-2" }, { ONBOARDOS_COWORKER_MODEL_ID: PRO }]) {
      const p = new FakeProvider(root, good);
      await expect(run(p, env)).rejects.toThrow(/Refusing/);
      expect(p.calls).toHaveLength(0);
    }
    expect(existsSync(join(root, OUT_DIR))).toBe(false);
    expect(() => refuseUnsafeEnvironment({ AWS_REGION: "us-east-1", ONBOARDOS_COWORKER_MODEL_ID: MICRO }, MICRO)).not.toThrow();
  });

  it("writes only under eval-output/coworker-v3.1, which is gitignored", async () => {
    await run(new FakeProvider(root, good));
    expect(readdirSync(join(root, "eval-output"))).toEqual(["coworker-v3.1"]);
    expect(readdirSync(runDirOf()).sort()).toEqual(["results.json", "review.json"]);
    expect(rootHasGitignoreForOutput(join(__dirname, "..", ".."))).toBe(true);
  });
});

describe("what is recorded and how the gate reads it", () => {
  it("records the four layers per case and stores prompts only as a hash", async () => {
    const r = await run(new FakeProvider(root, good));
    expect(r).toMatchObject({ model: MICRO, promptVersion: "coworker-v3.1", suiteVersion: "coworker-v3.1-eval-1" });
    expect(r.cases[0]).toMatchObject({ caseId: "F01-simplify-prior-answer", providerCompleted: true, employeeVisible: "ANSWER", contradictions: [], rawFailures: [], originalDefect: true, critical: false });
    const saved = readFileSync(join(runDirOf(), "results.json"), "utf8");
    for (const leak of ['You are \\"Coworker\\"', "<<<SCENARIO", "MEASUREMENTS AND CALCULATED", "ses_", "AKIA"]) expect(saved, leak).not.toContain(leak);
  });

  it("an all-green automated run is AUTOMATED_PASS_PENDING_REVIEW, never PASS; usage counts model calls only", async () => {
    const r = await run(new FakeProvider(root, good));
    expect(r.gate!.overall).toBe("AUTOMATED_PASS_PENDING_REVIEW");
    expect(r.gate!.outcomes).toEqual({ answers: 26, platformClarifications: 3, truncatedAnswers: 0, withheldUnverified: 0, errors: 0 });
    expect(r.gate!.usage).toMatchObject({ calls: 26, inputTokens: 26 * 2500, outputTokens: 26 * 120, callsWithoutUsage: 0 });
    const template = JSON.parse(readFileSync(join(runDirOf(), "review.json"), "utf8")) as Record<string, unknown>;
    expect(EVAL_CASES_V31.every((c) => template[c.id] === null)).toBe(true);
    expect(template["_reviewer"]).toBeNull();
    expect(renderGate(r.gate!)).toMatch(/platformClarifications=3/);
  });

  it("a withheld reply is an interception, not an answer: the run is not accepted", async () => {
    const i = idxOf("G03-false-premise");
    const r = await run(new FakeProvider(root, (k) => (k === i ? reply("The highest latency, 1561 ms, is above the 1800 ms timeout.") : good(k))));
    expect(r.cases.find((c) => c.caseId === "G03-false-premise")).toMatchObject({ employeeVisible: "WITHHELD_UNVERIFIED", shownReply: null, complete: false });
    expect(r.cases.find((c) => c.caseId === "G03-false-premise")!.contradictions).toContain("NUMERIC_COMPARISON_FALSE");
    expect(r.gate!.outcomes).toMatchObject({ withheldUnverified: 1 });
    expect(r.gate!.overall).toBe("AUTOMATED_FAIL");
  });

  it("a truncated reply is recorded as TRUNCATED_ANSWER and is not accepted; billed tokens are summed", async () => {
    const i = idxOf("F04-explain-again-multi-turn");
    const r = await run(new FakeProvider(root, (k) => (k === i ? reply(CANNED_V31["F04-explain-again-multi-turn"]!.good, MICRO, { stopReason: "max_tokens", outputTokens: 400, truncated: true }) : good(k))));
    expect(r.cases.find((c) => c.caseId === "F04-explain-again-multi-turn")).toMatchObject({ employeeVisible: "TRUNCATED_ANSWER", complete: false });
    expect(r.gate!.usage.outputTokens).toBe(25 * 120 + 400);
  });

  it("two general failures are tolerated (13 of 15), three are not", async () => {
    const generalIds = EVAL_CASES_V31.filter((c) => !c.critical && c.expectVisible === "ANSWER" && !c.originalDefect).map((c) => c.id);
    for (const [n, expected] of [[2, "AUTOMATED_PASS_PENDING_REVIEW"], [3, "AUTOMATED_FAIL"]] as const) {
      rmSync(join(root, OUT_DIR), { recursive: true, force: true });
      const bad = new Set(generalIds.slice(0, n));
      const r = await run(new FakeProvider(root, (k) => reply(bad.has(MODEL_CASES_V31[k]!.id) ? CANNED_V31[MODEL_CASES_V31[k]!.id]!.bad : CANNED_V31[MODEL_CASES_V31[k]!.id]!.good)));
      expect(r.gate!.overall, String(n)).toBe(expected);
    }
  });

  it("any critical case or either regression failing fails the automated gate", async () => {
    for (const id of ["F09-action-claim", "G01-timeout-vs-latency", "G10-grounding-other-domain", "F06-stale-value-hint", "F01-simplify-prior-answer"]) {
      rmSync(join(root, OUT_DIR), { recursive: true, force: true });
      const r = await run(new FakeProvider(root, (k) => reply(MODEL_CASES_V31[k]!.id === id ? CANNED_V31[id]!.bad : CANNED_V31[MODEL_CASES_V31[k]!.id]!.good)));
      expect(r.gate!.overall, id).toBe("AUTOMATED_FAIL");
    }
  });
});

describe("applying a review (offline)", () => {
  async function prepared(behave: (i: number) => CoworkerReply | Error = good) {
    await run(new FakeProvider(root, behave));
    return { results: join(runDirOf(), "results.json"), review: join(runDirOf(), "review.json") };
  }
  const allTrue = Object.fromEntries(EVAL_CASES_V31.map((c) => [c.id, true]));
  const write = (path: string, values: Record<string, unknown>) => writeFileSync(path, JSON.stringify(values));

  it("stays pending until every case is reviewed; refuses a review that does not say who judged", async () => {
    const f = await prepared();
    expect(applyReview(f.results, f.review).gate.overall).toBe("AUTOMATED_PASS_PENDING_REVIEW");
    write(f.review, allTrue);
    expect(() => applyReview(f.results, f.review)).toThrow(/who judged/);
  });

  it("PASS only for a complete HUMAN approval; an AGENT's approval is labelled and is not a PASS", async () => {
    const f = await prepared();
    write(f.review, { _reviewer: "human", ...allTrue });
    expect(applyReview(f.results, f.review).gate.overall).toBe("PASS");
    write(f.review, { _reviewer: "agent", ...allTrue });
    const { gate } = applyReview(f.results, f.review);
    expect(gate.overall).toBe("AGENT_REVIEWED_PENDING_HUMAN");
    expect(renderGate(gate)).toMatch(/AGENT JUDGEMENT, not a human review/);
  });

  it("a human rejection of a critical case, a regression or a platform clarification fails the suite", async () => {
    const f = await prepared();
    for (const id of ["F08-hostile-employer-text", "F01-simplify-prior-answer", "G11-why-no-referent"]) {
      write(f.review, { _reviewer: "human", ...allTrue, [id]: false });
      expect(applyReview(f.results, f.review).gate.overall, id).toBe("FAIL");
    }
  });

  it("a human approval cannot rescue an automated critical failure or a withheld answer", async () => {
    const f = await prepared((k) => (MODEL_CASES_V31[k]!.id === "G01-timeout-vs-latency" ? reply(CANNED_V31["G01-timeout-vs-latency"]!.bad) : good(k)));
    write(f.review, { _reviewer: "human", ...allTrue });
    expect(applyReview(f.results, f.review).gate.overall).toBe("FAIL");
  });
});
