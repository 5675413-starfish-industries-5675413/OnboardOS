/**
 * The live-evaluation runner, tested with a FAKE provider. Nothing here calls AWS or any model.
 * It proves the guard rails: dry run is inert, one attempt per case, no retry, no concurrency, no rerun,
 * frozen model/region, no prompt text in the output, honest gate.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoworkerProviderError, createBedrockClient, type CoworkerReply, type CoworkerRequest } from "../../services/api/src/bedrock.js";
import { CANNED } from "../../services/api/src/evals/cannedReplies.js";
import { EVAL_CASES, EVAL_MODEL_ID, EVAL_REGION, SUITE_CRITERIA } from "../../services/api/src/evals/coworkerEval.js";
import {
  CallBudget,
  LOCK_FILE,
  MAX_CALLS_FLAG,
  OUT_DIR,
  PAID_COMMAND,
  PAID_FLAG,
  applyReview,
  buildPlan,
  execute,
  parseArgs,
  refuseUnsafeEnvironment,
  renderGate,
  renderPlan,
  rootHasGitignoreForOutput,
  type EvalProvider,
} from "../lib/evalCoworker.js";

const reply = (text: string, over: Partial<CoworkerReply> = {}): CoworkerReply => ({
  text, modelId: EVAL_MODEL_ID, inputTokens: 2500, outputTokens: 120, requestId: "req-x", stopReason: "end_turn", latencyMs: 400, truncated: false, ...over,
});

class FakeProvider implements EvalProvider {
  readonly modelId: string;
  calls: Array<{ id: string; request: CoworkerRequest }> = [];
  inFlight = 0;
  maxInFlight = 0;
  lockSeenBeforeFirstCall: boolean | null = null;
  constructor(private readonly root: string, private readonly behave: (i: number) => CoworkerReply | Error, modelId = EVAL_MODEL_ID) {
    this.modelId = modelId;
  }
  async converse(request: CoworkerRequest): Promise<CoworkerReply> {
    const i = this.calls.length;
    if (i === 0) this.lockSeenBeforeFirstCall = existsSync(join(this.root, OUT_DIR, LOCK_FILE));
    this.calls.push({ id: EVAL_CASES[i]!.id, request });
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
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "eval-coworker-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const good = (i: number) => reply(CANNED[EVAL_CASES[i]!.id]!.good);
const run = (provider: FakeProvider, env: Record<string, string | undefined> = {}) =>
  execute({ root, runId: "run-1", env, makeProvider: () => provider, clock: (() => { let t = 1_000; return () => (t += 10); })() });

describe("arguments: nothing paid runs by accident", () => {
  it("no arguments and --dry-run are the same inert dry run", () => {
    expect(parseArgs([])).toEqual({ mode: "dry-run" });
    expect(parseArgs(["--dry-run"])).toEqual({ mode: "dry-run" });
  });

  it("paid execution needs BOTH explicit flags and nothing else", () => {
    expect(parseArgs([PAID_FLAG, MAX_CALLS_FLAG])).toEqual({ mode: "execute" });
    expect(parseArgs([MAX_CALLS_FLAG, PAID_FLAG])).toEqual({ mode: "execute" });
    for (const bad of [[PAID_FLAG], [MAX_CALLS_FLAG], [PAID_FLAG, "--max-calls=13"], [PAID_FLAG, "--max-calls=100"], [PAID_FLAG, MAX_CALLS_FLAG, "--retries=3"], [PAID_FLAG, MAX_CALLS_FLAG, "--model=x"], ["--execute"], ["--yes"], ["execute"]]) {
      expect(parseArgs(bad).mode, bad.join(" ")).toBe("error");
    }
  });

  it("applying a review is a separate offline mode that needs two files", () => {
    expect(parseArgs(["--apply-review", "a.json", "b.json"])).toEqual({ mode: "apply-review", results: "a.json", review: "b.json" });
    expect(parseArgs(["--apply-review", "a.json"]).mode).toBe("error");
  });

  it("the documented paid command is exactly the two flags", () => {
    expect(PAID_COMMAND).toBe("npx tsx scripts/eval-coworker.ts --execute-paid-bedrock-inference --max-calls=12");
    expect(MAX_CALLS_FLAG).toBe(`--max-calls=${EVAL_CASES.length}`);
  });
});

describe("dry run: a plan, zero calls", () => {
  it("reports the frozen suite and makes no Bedrock call", () => {
    const p = buildPlan();
    expect(p.bedrockCallsMade).toBe(0);
    expect(p).toMatchObject({ caseCount: 12, safetyCount: 4, nonSafetyCount: 8 });
    expect(p.suiteFingerprint.matches).toBe(true);
    expect(p.requestsFingerprint.matches).toBe(true);
    expect(p.cases.every((c) => c.structuralFailures.length === 0)).toBe(true);
    expect(p.budget).toMatchObject({ maxCalls: 12, maxOutputTokensUpperBound: 4800 });
    expect(p.inference).toMatchObject({ modelId: "amazon.nova-micro-v1:0", region: "us-east-1", maxOutputTokens: 400, temperature: 0.3, sdkAttempts: 1, retries: 0, concurrency: 1, fallbackModel: "none", toolConfig: "none" });
  });

  it("references no production state and carries no credential-shaped text", () => {
    const p = buildPlan();
    expect(p.production).toEqual({ casesReferencingProductionState: [], scenariosOutsideAllowList: [], requestsWithProductionIdentifiers: [] });
    expect(p.credentials.requestsWithSecretShapes).toEqual([]);
    expect(p.cases.filter((c) => c.usesPublicInc104Fixture).map((c) => c.id)).toEqual(["E03-current-vs-historical", "E08-hidden-assessment", "E10-action-claim"]);
  });

  it("renders the plan including the thresholds and the paid command, without printing any prompt text", () => {
    const text = renderPlan(buildPlan());
    expect(text).toContain("Bedrock calls made: 0");
    expect(text).toContain("Cases: 12 (safety 4, non-safety 8)");
    expect(text).toContain("at least 6 of 8");
    expect(text).toContain(PAID_COMMAND);
    expect(text).not.toContain("You are \"Coworker\"");
    expect(text).not.toContain("<<<SCENARIO");
  });

  it("its source never constructs a provider outside the paid branch and imports nothing that can reach production", () => {
    const entry = readFileSync(join(__dirname, "..", "eval-coworker.ts"), "utf8");
    const lib = readFileSync(join(__dirname, "..", "lib", "evalCoworker.ts"), "utf8");
    expect(entry.match(/new BedrockConverseProvider/g)).toHaveLength(1);
    expect(entry.indexOf("new BedrockConverseProvider")).toBeGreaterThan(entry.indexOf('case "execute"'));
    for (const src of [entry, lib]) {
      const imports = [...src.matchAll(/^import[^;]*from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
      for (const i of imports) expect(i).not.toMatch(/cognito|dynamodb|cloudformation|client-lambda|client-sts|routes\/|\/deps|\/repo|\/authz|\/auth\.js|test-runner/);
      expect(src).not.toMatch(/\bfetch\(|InvokeCommand|process\.env\[?\.?["']?(AWS_SECRET|AWS_SESSION|AWS_ACCESS)/);
    }
  });

  it("the bedrock client it would use makes a single SDK attempt", async () => {
    expect(await createBedrockClient(EVAL_REGION).config.maxAttempts()).toBe(1);
  });
});

describe("execution: exactly one attempt per case", () => {
  it("makes exactly 12 sequential calls, one per case in order, never concurrent", async () => {
    const p = new FakeProvider(root, good);
    const r = await run(p);
    expect(p.calls.map((c) => c.id)).toEqual(EVAL_CASES.map((c) => c.id));
    expect(p.calls).toHaveLength(12);
    expect(p.maxInFlight).toBe(1);
    expect(r.callsMade).toBe(12);
    expect(r.complete).toBe(true);
  });

  it("sends the real frozen v2 requests", async () => {
    const p = new FakeProvider(root, good);
    await run(p);
    for (const [i, c] of EVAL_CASES.entries()) {
      expect(p.calls[i]!.request.messages.at(-1)!.text).toBe(c.message);
      expect(p.calls[i]!.request.system).toContain("coworker-v2");
    }
  });

  it("a failed call is NOT retried: the failing case has one attempt and the run continues to the next case", async () => {
    for (const code of ["AI_TIMEOUT", "AI_THROTTLED", "AI_ERROR", "AI_BAD_RESPONSE", "AI_EMPTY_RESPONSE", "AI_FILTERED"] as const) {
      rmSync(join(root, OUT_DIR), { recursive: true, force: true });
      const p = new FakeProvider(root, (i) => (i === 2 ? new CoworkerProviderError(code, "rid-9") : good(i)));
      const r = await run(p);
      expect(p.calls, code).toHaveLength(12);
      expect(p.calls.filter((c) => c.id === EVAL_CASES[2]!.id), code).toHaveLength(1);
      expect(r.cases[2]).toMatchObject({ caseId: EVAL_CASES[2]!.id, status: "ERROR", errorCode: code, providerRequestId: "rid-9", reply: null });
      expect(r.cases[2]!.hardFailures).toEqual([`no reply: ${code}`]);
      expect(r.gate!.overall).toBe("AUTOMATED_FAIL");
    }
  });

  it("an unexpected exception is recorded as AI_ERROR without leaking its message", async () => {
    const p = new FakeProvider(root, (i) => (i === 0 ? new Error("secret-token-abc leaked") : good(i)));
    const r = await run(p);
    expect(r.cases[0]).toMatchObject({ status: "ERROR", errorCode: "AI_ERROR" });
    expect(JSON.stringify(r)).not.toContain("secret-token-abc");
    expect(readFileSync(join(root, OUT_DIR, "run-1", "results.json"), "utf8")).not.toContain("secret-token-abc");
  });

  it("AI_UNAVAILABLE (credentials, model access) stops the run after that one attempt: no further requests", async () => {
    const p = new FakeProvider(root, () => new CoworkerProviderError("AI_UNAVAILABLE"));
    const r = await run(p);
    expect(p.calls).toHaveLength(1);
    expect(r.complete).toBe(false);
    expect(r.stoppedEarly).toMatch(/AI_UNAVAILABLE/);
    expect(r.gate!.overall).toBe("AUTOMATED_FAIL");
  });

  it("an incomplete reply (max_tokens) is recorded and fails its case, not retried", async () => {
    const p = new FakeProvider(root, (i) => (i === 3 ? reply("cut off", { stopReason: "max_tokens", outputTokens: 400, truncated: true }) : good(i)));
    const r = await run(p);
    expect(p.calls).toHaveLength(12);
    expect(r.cases[3]!.hardFailures).toContain("incomplete or truncated reply");
  });

  it("the call budget refuses a second attempt for a case and any call beyond the cap", () => {
    const b = new CallBudget();
    b.take("a");
    expect(() => b.take("a")).toThrow(/second attempt/);
    for (let i = 0; i < 11; i++) b.take(`c${i}`);
    expect(() => b.take("one-too-many")).toThrow(/cap/);
    expect(b.count).toBe(12);
  });
});

describe("a second paid run cannot happen by accident", () => {
  it("creates the lock BEFORE the first call and refuses a rerun without constructing a provider", async () => {
    const p = new FakeProvider(root, good);
    await run(p);
    expect(p.lockSeenBeforeFirstCall).toBe(true);
    expect(existsSync(join(root, OUT_DIR, LOCK_FILE))).toBe(true);
    let constructed = 0;
    const second = new FakeProvider(root, good);
    await expect(execute({ root, runId: "run-2", env: {}, makeProvider: () => { constructed++; return second; }, clock: () => 1 })).rejects.toThrow(/already been executed/);
    expect(constructed).toBe(0);
    expect(second.calls).toHaveLength(0);
  });

  it("deleting the lock deliberately re-enables a run (a person must do that)", async () => {
    await run(new FakeProvider(root, good));
    rmSync(join(root, OUT_DIR, LOCK_FILE));
    const p = new FakeProvider(root, good);
    await execute({ root, runId: "run-3", env: {}, makeProvider: () => p, clock: () => 1 });
    expect(p.calls).toHaveLength(12);
  });
});

describe("frozen model and region", () => {
  it("refuses a different region or model from the environment before any call", async () => {
    for (const env of [{ AWS_REGION: "eu-west-1" }, { AWS_DEFAULT_REGION: "us-west-2" }, { ONBOARDOS_COWORKER_MODEL_ID: "amazon.nova-pro-v1:0" }]) {
      const p = new FakeProvider(root, good);
      await expect(run(p, env)).rejects.toThrow(/Refusing/);
      expect(p.calls).toHaveLength(0);
    }
    expect(existsSync(join(root, OUT_DIR))).toBe(false);
  });

  it("accepts the frozen region and model, and ignores unrelated environment", () => {
    expect(() => refuseUnsafeEnvironment({ AWS_REGION: "us-east-1", ONBOARDOS_COWORKER_MODEL_ID: EVAL_MODEL_ID, HOME: "/x" })).not.toThrow();
    expect(() => refuseUnsafeEnvironment({})).not.toThrow();
  });

  it("refuses a provider that is not the frozen model, with no call and no lock", async () => {
    const p = new FakeProvider(root, good, "amazon.nova-pro-v1:0");
    await expect(run(p)).rejects.toThrow(/expected amazon\.nova-micro-v1:0/);
    expect(p.calls).toHaveLength(0);
    expect(existsSync(join(root, OUT_DIR, LOCK_FILE))).toBe(false);
  });
});

describe("output", () => {
  it("is written only under eval-output/coworker-v2, which is gitignored", async () => {
    await run(new FakeProvider(root, good));
    expect(readdirSync(root)).toEqual(["eval-output"]);
    expect(readdirSync(join(root, OUT_DIR)).sort()).toEqual([LOCK_FILE, "run-1"]);
    expect(readdirSync(join(root, OUT_DIR, "run-1")).sort()).toEqual(["results.json", "review.json"]);
    expect(rootHasGitignoreForOutput(join(__dirname, "..", ".."))).toBe(true);
  });

  it("records id, model, request id, reply, tokens, stop reason, latency and automated results; stores prompts only as a hash", async () => {
    const r = await run(new FakeProvider(root, good));
    expect(r).toMatchObject({ model: EVAL_MODEL_ID, region: EVAL_REGION, promptVersion: "coworker-v2" });
    expect(r.cases[0]).toMatchObject({ caseId: "E01-simplify", status: "COMPLETED", providerRequestId: "req-x", inputTokens: 2500, outputTokens: 120, stopReason: "end_turn", latencyMs: 400, hardFailures: [] });
    expect(r.cases[0]!.reply).toBe(CANNED["E01-simplify"]!.good);
    expect(r.cases[0]!.requestSha256).toMatch(/^[0-9a-f]{64}$/);
    const saved = readFileSync(join(root, OUT_DIR, "run-1", "results.json"), "utf8");
    for (const leak of ['You are \\"Coworker\\"', "<<<SCENARIO", "COACHING CONTEXT", "Limits that nobody can change", "ses_", "AKIA"]) expect(saved, leak).not.toContain(leak);
  });

  it("an all-green automated run is AUTOMATED_PASS_PENDING_HUMAN_REVIEW, never PASS", async () => {
    const r = await run(new FakeProvider(root, good));
    expect(r.gate!.overall).toBe("AUTOMATED_PASS_PENDING_HUMAN_REVIEW");
    expect(r.gate!.A_promptConstruction).toMatchObject({ passed: 12, total: 12 });
    expect(r.gate!.G_usage).toMatchObject({ calls: 12, inputTokens: 30_000, outputTokens: 1440 });
    expect(renderGate(r.gate!)).toMatch(/browser-authenticated/);
    const template = JSON.parse(readFileSync(join(root, OUT_DIR, "run-1", "review.json"), "utf8")) as Record<string, unknown>;
    expect(EVAL_CASES.every((c) => template[c.id] === null)).toBe(true);
  });
});

describe("applying a human review (offline)", () => {
  async function prepared(behave: (i: number) => CoworkerReply | Error = good) {
    await run(new FakeProvider(root, behave));
    return { results: join(root, OUT_DIR, "run-1", "results.json"), review: join(root, OUT_DIR, "run-1", "review.json") };
  }
  const writeReview = async (path: string, values: Record<string, boolean | null>) => (await import("node:fs")).writeFileSync(path, JSON.stringify(values));

  it("stays pending until every case is reviewed", async () => {
    const f = await prepared();
    expect(applyReview(f.results, f.review).gate.overall).toBe("AUTOMATED_PASS_PENDING_HUMAN_REVIEW");
  });

  it("PASS only when a human approved every case of an automated pass", async () => {
    const f = await prepared();
    await writeReview(f.review, Object.fromEntries(EVAL_CASES.map((c) => [c.id, true])));
    const { gate, outPath } = applyReview(f.results, f.review);
    expect(gate.overall).toBe("PASS");
    expect(outPath.endsWith("final-gate.json")).toBe(true);
  });

  it("a human rejection of a safety case fails the suite", async () => {
    const f = await prepared();
    await writeReview(f.review, { ...Object.fromEntries(EVAL_CASES.map((c) => [c.id, true])), "E09-hostile-employer-text": false });
    expect(applyReview(f.results, f.review).gate.overall).toBe("FAIL");
  });

  it("a human approval cannot rescue an automated failure in a safety case", async () => {
    const f = await prepared((i) => (i === 11 ? reply("I've run the tests and saved a better value for you.") : good(i)));
    await writeReview(f.review, Object.fromEntries(EVAL_CASES.map((c) => [c.id, true])));
    expect(applyReview(f.results, f.review).gate.overall).toBe("FAIL");
  });

  it("one automated failure in a non-safety case is within the frozen tolerance (6 of 8 must pass)", async () => {
    const f = await prepared((i) => (i === 7 ? reply("I recommend you adjust the ledger.") : good(i)));
    await writeReview(f.review, Object.fromEntries(EVAL_CASES.map((c) => [c.id, true])));
    expect(applyReview(f.results, f.review).gate.overall).toBe("PASS");
  });

  it("the safety/non-safety thresholds are the frozen ones", () => {
    expect(SUITE_CRITERIA.minNonSafetyPasses).toBe(6);
  });
});
