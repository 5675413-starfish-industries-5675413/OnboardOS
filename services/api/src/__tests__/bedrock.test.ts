import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BedrockConverseProvider,
  COWORKER_ERROR_MESSAGES,
  COWORKER_CALL_TIMEOUT_MS,
  CoworkerProviderError,
  bedrockProviderFromEnv,
  classifyProviderError,
  createBedrockClient,
} from "../bedrock.js";

const MODEL = "amazon.nova-micro-v1:0";
const REQ = { system: "SYS", messages: [{ role: "user" as const, text: "hello" }] };

function sender(result: unknown | (() => unknown)) {
  const send = vi.fn(async (_cmd: unknown, _opts?: unknown) => {
    const r = typeof result === "function" ? (result as () => unknown)() : result;
    if (r instanceof Error) throw r;
    return r as never;
  });
  return { send } as unknown as { send: typeof send };
}
const ok = (over: Record<string, unknown> = {}) => ({
  output: { message: { role: "assistant", content: [{ text: "  Check the upstream latency.  " }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
  metrics: { latencyMs: 228 },
  $metadata: { requestId: "req-abc" },
  ...over,
});
const named = (name: string, requestId?: string) =>
  Object.assign(new Error("RAW PROVIDER TEXT arn:aws:bedrock:us-east-1:123456789012:secret"), { name, ...(requestId ? { $metadata: { requestId } } : {}) });
const codeOf = async (p: Promise<unknown>) => (await p.catch((e: unknown) => e)) as CoworkerProviderError;

afterEach(() => vi.unstubAllEnvs());

describe("Converse request", () => {
  it("sends exactly the configured model, system prompt, messages and inference limits", async () => {
    const s = sender(ok());
    await new BedrockConverseProvider(s, MODEL).converse({
      system: "SYS",
      messages: [{ role: "user", text: "q1" }, { role: "assistant", text: "a1" }, { role: "user", text: "q2" }],
    });
    expect(s.send).toHaveBeenCalledTimes(1);
    const [cmd, opts] = s.send.mock.calls[0]!;
    expect(cmd).toBeInstanceOf(ConverseCommand);
    expect((cmd as ConverseCommand).input).toEqual({
      modelId: MODEL,
      system: [{ text: "SYS" }],
      messages: [
        { role: "user", content: [{ text: "q1" }] },
        { role: "assistant", content: [{ text: "a1" }] },
        { role: "user", content: [{ text: "q2" }] },
      ],
      inferenceConfig: { maxTokens: 400, temperature: 0.3 },
    });
    expect((opts as { abortSignal: AbortSignal }).abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("never configures tools, guardrails or extra model fields: the model can only return text", async () => {
    const s = sender(ok());
    await new BedrockConverseProvider(s, MODEL).converse(REQ);
    const input = (s.send.mock.calls[0]![0] as ConverseCommand).input as unknown as Record<string, unknown>;
    for (const k of ["toolConfig", "guardrailConfig", "additionalModelRequestFields", "additionalModelResponseFieldPaths", "promptVariables"]) {
      expect(input, k).not.toHaveProperty(k);
    }
  });

  it("uses the model it was constructed with, never anything from the request", async () => {
    const s = sender(ok());
    await new BedrockConverseProvider(s, "some.other-model").converse({ ...REQ, modelId: "attacker.model" } as never);
    expect(((s.send.mock.calls[0]![0] as ConverseCommand).input as { modelId: string }).modelId).toBe("some.other-model");
  });
});

describe("Converse response", () => {
  it("returns trimmed text with model, usage, request id, stop reason and latency", async () => {
    const r = await new BedrockConverseProvider(sender(ok()), MODEL).converse(REQ);
    expect(r).toEqual({
      text: "Check the upstream latency.", modelId: MODEL, inputTokens: 11, outputTokens: 5,
      requestId: "req-abc", stopReason: "end_turn", latencyMs: 228, truncated: false,
    });
  });
  it("joins multiple text blocks and ignores non-text blocks", async () => {
    const s = sender(ok({ output: { message: { content: [{ text: "One. " }, { toolUse: { name: "x" } }, { text: "Two." }] } } }));
    expect((await new BedrockConverseProvider(s, MODEL).converse(REQ)).text).toBe("One. Two.");
  });
  it("flags an answer cut at the output limit as truncated (still usable)", async () => {
    const r = await new BedrockConverseProvider(sender(ok({ stopReason: "max_tokens" })), MODEL).converse(REQ);
    expect(r).toMatchObject({ truncated: true, stopReason: "max_tokens" });
  });
  it("tolerates missing usage, metrics and request id", async () => {
    const r = await new BedrockConverseProvider(sender(ok({ usage: undefined, metrics: undefined, $metadata: {} })), MODEL).converse(REQ);
    expect(r).toMatchObject({ inputTokens: 0, outputTokens: 0, latencyMs: null, requestId: null });
  });

  it.each([
    ["no output", { output: undefined }, "AI_BAD_RESPONSE"],
    ["no message", { output: {} }, "AI_BAD_RESPONSE"],
    ["content not an array", { output: { message: { content: "text" } } }, "AI_BAD_RESPONSE"],
    ["a null body", null, "AI_BAD_RESPONSE"],
    ["a missing stop reason", { stopReason: undefined }, "AI_BAD_RESPONSE"],
    ["an unknown stop reason", { stopReason: "something_new" }, "AI_BAD_RESPONSE"],
    ["a tool_use stop (tools are never configured)", { stopReason: "tool_use" }, "AI_BAD_RESPONSE"],
    ["empty content", { output: { message: { content: [] } } }, "AI_EMPTY_RESPONSE"],
    ["whitespace-only text", { output: { message: { content: [{ text: "   \n " }] } } }, "AI_EMPTY_RESPONSE"],
    ["only non-text blocks", { output: { message: { content: [{ image: {} }] } } }, "AI_EMPTY_RESPONSE"],
    ["content_filtered", { stopReason: "content_filtered" }, "AI_FILTERED"],
    ["guardrail_intervened", { stopReason: "guardrail_intervened" }, "AI_FILTERED"],
  ])("rejects %s as %s", async (_n, over, code) => {
    const body = over === null ? null : ok(over as Record<string, unknown>);
    const e = await codeOf(new BedrockConverseProvider(sender(body), MODEL).converse(REQ));
    expect(e).toBeInstanceOf(CoworkerProviderError);
    expect(e.code).toBe(code);
  });
});

describe("error categories", () => {
  it.each([
    ["ThrottlingException", "AI_THROTTLED"],
    ["ServiceQuotaExceededException", "AI_THROTTLED"],
    ["AccessDeniedException", "AI_UNAVAILABLE"],
    ["ValidationException", "AI_UNAVAILABLE"],
    ["ResourceNotFoundException", "AI_UNAVAILABLE"],
    ["ModelNotReadyException", "AI_UNAVAILABLE"],
    ["ModelTimeoutException", "AI_TIMEOUT"],
    ["TimeoutError", "AI_TIMEOUT"],
    ["AbortError", "AI_TIMEOUT"],
    ["InternalServerException", "AI_ERROR"],
    ["ServiceUnavailableException", "AI_ERROR"],
    ["SomethingUnheardOf", "AI_ERROR"],
  ])("%s -> %s, carrying the request id but none of the provider's text", async (name, code) => {
    const e = await codeOf(new BedrockConverseProvider(sender(named(name, "rid-9")), MODEL).converse(REQ));
    expect(e.code).toBe(code);
    expect(e.requestId).toBe("rid-9");
    expect(e.message).toBe(code);
    expect(JSON.stringify(e)).not.toMatch(/RAW PROVIDER|arn:aws|123456789012/);
  });

  it("treats a non-Error rejection as a generic AI_ERROR", async () => {
    const s = { send: vi.fn(async () => { throw "boom"; }) };
    expect((await codeOf(new BedrockConverseProvider(s as never, MODEL).converse(REQ))).code).toBe("AI_ERROR");
    expect(classifyProviderError(undefined).code).toBe("AI_ERROR");
  });

  it("has a fixed, user-safe message for every code", () => {
    for (const code of ["AI_UNAVAILABLE", "AI_THROTTLED", "AI_TIMEOUT", "AI_ERROR", "AI_BAD_RESPONSE", "AI_EMPTY_RESPONSE", "AI_FILTERED", "STRANDED"] as const) {
      expect(COWORKER_ERROR_MESSAGES[code].length).toBeGreaterThan(10);
      expect(COWORKER_ERROR_MESSAGES[code]).not.toMatch(/arn:|exception|bedrock|aws/i);
    }
  });
});

describe("timeout and retries", () => {
  it("aborts a call that outlives its timeout and reports AI_TIMEOUT", async () => {
    const s = {
      send: vi.fn((_c: unknown, o: { abortSignal: AbortSignal }) =>
        new Promise((_res, rej) => o.abortSignal.addEventListener("abort", () => rej(o.abortSignal.reason))),
      ),
    };
    const e = await codeOf(new BedrockConverseProvider(s as never, MODEL, 30).converse(REQ));
    expect(e.code).toBe("AI_TIMEOUT");
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it("makes exactly one send per converse, even after a failure (no automatic retry)", async () => {
    const s = sender(named("ThrottlingException"));
    await codeOf(new BedrockConverseProvider(s, MODEL).converse(REQ));
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it("the real SDK client is configured for a single attempt in the right region", async () => {
    const c = createBedrockClient("us-east-1");
    expect(await c.config.maxAttempts()).toBe(1);
    expect(await c.config.region()).toBe("us-east-1");
  });

  it("the request timeout is really applied to the handler the SDK will use (not silently dropped)", async () => {
    const handler = createBedrockClient("us-east-1").config.requestHandler as unknown as { constructor: { name: string }; configProvider: Promise<Record<string, unknown>> };
    expect(handler.constructor.name).toBe("NodeHttp2Handler");
    expect(await handler.configProvider).toEqual({ requestTimeout: 20_000, disableConcurrentStreams: true });
  });

  it("the call timeout stays inside the Lambda limit with room for the surrounding DynamoDB work", () => {
    // API function timeout is 29 s (template Globals); API Gateway's integration limit is 30 s.
    expect(COWORKER_CALL_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
    expect(COWORKER_CALL_TIMEOUT_MS + 5_000).toBeLessThan(29_000);
  });
});

describe("configuration from the environment", () => {
  it("is OFF (null) when no model is configured, including blank values", () => {
    vi.stubEnv("ONBOARDOS_COWORKER_MODEL_ID", "");
    expect(bedrockProviderFromEnv()).toBeNull();
    vi.stubEnv("ONBOARDOS_COWORKER_MODEL_ID", "   ");
    expect(bedrockProviderFromEnv()).toBeNull();
  });
  it("uses the configured model id", () => {
    vi.stubEnv("ONBOARDOS_COWORKER_MODEL_ID", MODEL);
    expect(bedrockProviderFromEnv()?.modelId).toBe(MODEL);
  });
});
