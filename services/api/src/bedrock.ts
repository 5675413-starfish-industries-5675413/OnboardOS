/**
 * Amazon Bedrock access for the AI coworker.
 *
 * The route code depends only on the {@link BedrockProvider} interface, so tests inject a
 * fake and never make a paid call. {@link BedrockConverseProvider} is the real adapter:
 *
 *  - Converse API, one model, configured server-side (never taken from a request);
 *  - NO toolConfig, no guardrail overrides, no additional model fields: the model returns
 *    text and nothing it says can cause a mutation;
 *  - one attempt only (`maxAttempts: 1`): the SDK's default retries could silently bill
 *    repeated calls, so a throttle is surfaced to the user instead;
 *  - a hard 20 s abort (the Lambda limit is 29 s);
 *  - provider errors are mapped to a small fixed vocabulary. Raw error messages, prompts
 *    and replies are never logged or returned.
 */

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

export type CoworkerErrorCode =
  | "AI_UNAVAILABLE"
  | "AI_THROTTLED"
  | "AI_TIMEOUT"
  | "AI_ERROR"
  | "AI_BAD_RESPONSE"
  | "AI_EMPTY_RESPONSE"
  | "AI_FILTERED"
  /** The model answered, but its answer contradicted the verified session facts and was withheld. */
  | "AI_UNVERIFIED";

/** One fixed, user-safe sentence per code. */
export const COWORKER_ERROR_MESSAGES: Record<CoworkerErrorCode | "STRANDED", string> = {
  AI_UNAVAILABLE: "The AI coworker is not available right now.",
  AI_THROTTLED: "The AI coworker is busy. Please try again in a moment.",
  AI_TIMEOUT: "The AI coworker took too long to answer. Please try again.",
  AI_ERROR: "The AI coworker could not answer. Please try again.",
  AI_BAD_RESPONSE: "The AI coworker returned an unusable answer, which was discarded.",
  AI_EMPTY_RESPONSE: "The AI coworker returned an empty answer. Please try rephrasing.",
  AI_FILTERED: "The AI coworker's answer was withheld by a safety filter. Please try rephrasing.",
  AI_UNVERIFIED: "The AI coworker's answer contradicted your verified session information, so it was withheld. Your tests, configuration and progress are unchanged. Please try rephrasing.",
  STRANDED: "This request did not finish. No answer was recorded; you can ask again.",
};

/** Failure of a provider call, already reduced to a code. Carries no provider text. */
export class CoworkerProviderError extends Error {
  readonly code: CoworkerErrorCode;
  /** The AWS request id when the service gave one (safe to log and store). */
  readonly requestId: string | null;
  constructor(code: CoworkerErrorCode, requestId: string | null = null) {
    super(code);
    this.name = "CoworkerProviderError";
    this.code = code;
    this.requestId = requestId;
  }
}

export interface CoworkerRequest {
  /** Trusted instructions followed by clearly delimited untrusted data. */
  system: string;
  /** Alternating conversation, starting and ending with the user. */
  messages: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
}

export interface CoworkerReply {
  text: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  requestId: string | null;
  /** `end_turn` / `stop_sequence` for a complete answer, `max_tokens` when cut short. */
  stopReason: string;
  latencyMs: number | null;
  /** The answer hit the output limit and may end mid-thought. */
  truncated: boolean;
}

export interface BedrockProvider {
  /** The model this provider will call; recorded on every turn. */
  readonly modelId: string;
  converse(request: CoworkerRequest): Promise<CoworkerReply>;
}

export const COWORKER_MAX_OUTPUT_TOKENS = 400;
export const COWORKER_TEMPERATURE = 0.3;
export const COWORKER_CALL_TIMEOUT_MS = 20_000;

const STOP_COMPLETE = new Set(["end_turn", "stop_sequence"]);
const STOP_FILTERED = new Set(["content_filtered", "guardrail_intervened"]);

type Sender = Pick<BedrockRuntimeClient, "send">;

/** Map an SDK/transport failure to a code by error NAME only. */
export function classifyProviderError(err: unknown): { code: CoworkerErrorCode; requestId: string | null } {
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    name?: unknown;
    $metadata?: { requestId?: unknown };
  };
  const name = typeof e.name === "string" ? e.name : "";
  const rid = typeof e.$metadata?.requestId === "string" ? e.$metadata.requestId : null;
  switch (name) {
    case "ThrottlingException":
    case "ServiceQuotaExceededException":
    case "TooManyRequestsException":
      return { code: "AI_THROTTLED", requestId: rid };
    case "TimeoutError":
    case "AbortError":
    case "ModelTimeoutException":
    case "RequestTimeout":
      return { code: "AI_TIMEOUT", requestId: rid };
    case "AccessDeniedException":
    case "ValidationException":
    case "ResourceNotFoundException":
    case "ModelNotReadyException":
    case "ModelErrorException":
    case "CredentialsProviderError":
      return { code: "AI_UNAVAILABLE", requestId: rid };
    default:
      return { code: "AI_ERROR", requestId: rid };
  }
}

export class BedrockConverseProvider implements BedrockProvider {
  constructor(
    private readonly client: Sender,
    readonly modelId: string,
    private readonly timeoutMs: number = COWORKER_CALL_TIMEOUT_MS,
  ) {}

  async converse(request: CoworkerRequest): Promise<CoworkerReply> {
    let out;
    try {
      out = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          system: [{ text: request.system }],
          messages: request.messages.map((m) => ({ role: m.role, content: [{ text: m.text }] })),
          inferenceConfig: { maxTokens: COWORKER_MAX_OUTPUT_TOKENS, temperature: COWORKER_TEMPERATURE },
          // Deliberately absent: toolConfig, guardrailConfig, additionalModelRequestFields.
        }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (err) {
      const { code, requestId } = classifyProviderError(err);
      throw new CoworkerProviderError(code, requestId);
    }

    if (typeof out !== "object" || out === null) throw new CoworkerProviderError("AI_BAD_RESPONSE");
    const requestId = typeof out.$metadata?.requestId === "string" ? out.$metadata.requestId : null;
    const stopReason = typeof out.stopReason === "string" ? out.stopReason : "";

    // Structure first: an unexpected shape is never turned into an answer.
    const content = out.output?.message?.content;
    if (!Array.isArray(content)) throw new CoworkerProviderError("AI_BAD_RESPONSE", requestId);
    if (STOP_FILTERED.has(stopReason)) throw new CoworkerProviderError("AI_FILTERED", requestId);
    const complete = STOP_COMPLETE.has(stopReason);
    const truncated = stopReason === "max_tokens";
    if (!complete && !truncated) throw new CoworkerProviderError("AI_BAD_RESPONSE", requestId);

    const text = content
      .map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
      .join("")
      .trim();
    if (text.length === 0) throw new CoworkerProviderError("AI_EMPTY_RESPONSE", requestId);

    const inTok = out.usage?.inputTokens;
    const outTok = out.usage?.outputTokens;
    return {
      text,
      modelId: this.modelId,
      inputTokens: typeof inTok === "number" ? inTok : 0,
      outputTokens: typeof outTok === "number" ? outTok : 0,
      requestId,
      stopReason,
      latencyMs: typeof out.metrics?.latencyMs === "number" ? out.metrics.latencyMs : null,
      truncated,
    };
  }
}

let cachedClient: BedrockRuntimeClient | undefined;

/**
 * The one SDK client: a single attempt (no hidden retries/billing) and a bounded request time.
 *
 * Bedrock Runtime's SDK uses an HTTP/2 handler, whose options are `requestTimeout` and
 * `disableConcurrentStreams` (`connectionTimeout` is an HTTP/1 option and would be ignored). Passing our own
 * options replaces the SDK's defaults, so `disableConcurrentStreams: true` (the SDK default) is restated.
 */
export function createBedrockClient(region: string): BedrockRuntimeClient {
  return new BedrockRuntimeClient({
    region,
    maxAttempts: 1,
    requestHandler: { requestTimeout: COWORKER_CALL_TIMEOUT_MS, disableConcurrentStreams: true },
  });
}

/**
 * The production provider, or null when no model is configured (the feature is then OFF and
 * reported honestly as unavailable). The model id is an environment value set by the stack,
 * never a request field.
 */
export function bedrockProviderFromEnv(): BedrockProvider | null {
  const modelId = (process.env["ONBOARDOS_COWORKER_MODEL_ID"] ?? "").trim();
  if (!modelId) return null;
  cachedClient ??= createBedrockClient(process.env["AWS_REGION"] ?? "us-east-1");
  return new BedrockConverseProvider(cachedClient, modelId);
}
