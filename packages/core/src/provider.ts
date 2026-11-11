import {RetryableError, TerminalError} from "@restatedev/restate-sdk";
import type {ClientFuture, RetryOptions} from "@restatedev/restate-sdk-gen";
import {
  APICallError,
  generateText,
  jsonSchema as aiSchema,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  Output,
  streamText,
  UnsupportedFunctionalityError,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import type {Tracer} from "@opentelemetry/api";
import {ContextOverflowError, ModelProtocolError} from "./errors.js";
import {journaledModel} from "./model.js";
import {awaitChild} from "./tool.js";
import {traceModel} from "./telemetry.js";
import {jsonSchema} from "./validation.js";
import type {
  Model,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  ToolCall,
} from "./types.js";
import {strictSchema} from "./strict-schema.js";

type GenerateSettings = Parameters<typeof generateText>[0];

export type ProviderOptions = {
  model: LanguageModel;
  retry?: RetryOptions;
  providerOptions?: GenerateSettings["providerOptions"];
  telemetry?: GenerateSettings["experimental_telemetry"];
  tracer?: Tracer;
  /** Marks the instructions, the newest message and the end of the previous
   * request as cache points, for providers that cache only where told:
   * Anthropic and Bedrock. A request then reads its prefix from the previous
   * step's cache. Others cache prefixes on their own and ignore these
   * options. Default: true. */
  caching?: boolean;
  /** Best-effort I/O inside one journal attempt. A new start replaces that step's
   * previous attempt; raw text/reasoning precedes output guardrails. */
  onChunk?(
    event: ModelChunk | {type: "start" | "finish"},
    info: {step: number; signal: AbortSignal},
  ): Promise<void>;
};
function finished(reason: string | undefined) {
  if (reason !== "stop" && reason !== "tool-calls")
    throw new ModelProtocolError(`Incomplete model response: ${reason ?? "unknown"}`);
}

function contextOverflow(error: APICallError): boolean {
  if (error.statusCode === 413) return true;
  const data: unknown = error.data;
  if (!data || typeof data !== "object" || !("error" in data)) return false;
  const detail = data.error;
  return (
    !!detail &&
    typeof detail === "object" &&
    "code" in detail &&
    detail.code === "context_length_exceeded"
  );
}

/** The wait a throttled provider asks for, in whole milliseconds. Read from
 * `retry-after-ms`, else `retry-after` in seconds or as an HTTP date, else,
 * for Google models, `RetryInfo` in the body. */
function retryAfter(error: APICallError, model: LanguageModel): number | undefined {
  const headers = error.responseHeaders ?? {};
  let ms = parseFloat(headers["retry-after-ms"] ?? "");
  const header = headers["retry-after"];
  if (Number.isNaN(ms) && header) {
    const seconds = parseFloat(header);
    ms = Number.isNaN(seconds) ? Date.parse(header) - Date.now() : seconds * 1000;
  }
  if (Number.isNaN(ms) && typeof model !== "string" && model.provider.startsWith("google."))
    ms = retryInfo(error.responseBody);
  return Number.isFinite(ms) && ms >= 0 ? Math.ceil(ms) : undefined;
}

const RETRY_INFO = "type.googleapis.com/google.rpc.RetryInfo";
/** Gemini sends the wait in the body instead, as a `RetryInfo` detail with a
 * duration such as "30s". */
function retryInfo(body: string | undefined): number {
  type Detail = {"@type"?: unknown; retryDelay?: unknown} | null;
  try {
    const parsed = JSON.parse(body ?? "") as {error?: {details?: Detail[]}} | null;
    const details = parsed?.error?.details;
    const info = Array.isArray(details)
      ? details.find((detail) => detail?.["@type"] === RETRY_INFO)
      : undefined;
    const delay = /^(\d+(?:\.\d+)?)s$/.exec(String(info?.retryDelay));
    return delay ? Number(delay[1]) * 1000 : NaN;
  } catch {
    return NaN;
  }
}
// Namespaced: each provider reads its own key, so no provider detection is needed.
const CACHE_POINT = {
  anthropic: {cacheControl: {type: "ephemeral"}},
  bedrock: {cachePoint: {type: "default"}},
} as const;

function messages(request: ModelRequest, caching: boolean): ModelMessage[] {
  const rendered = request.messages.map(renderMessage);
  if (!caching) return rendered;
  // The newest message moves the cache point forward each step. Anthropic
  // looks back only about 20 content blocks from a cache point for an earlier
  // prefix, and a step with ten parallel calls adds more than that, so a
  // second point marks where the previous request ended: just before the
  // newest model reply.
  const reply = request.messages.findLastIndex((message) => message.role === "assistant");
  for (const index of new Set([reply - 1, rendered.length - 1])) {
    const message = rendered[index];
    if (message) message.providerOptions = CACHE_POINT;
  }
  return rendered;
}

function renderMessage(message: ModelRequest["messages"][number]): ModelMessage {
  if (message.role === "user") return {role: "user", content: message.content};
  if (message.role === "tool")
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: message.callId,
          toolName: message.name,
          output: {type: "json", value: message.result},
        },
      ],
    };
  return {
    role: "assistant",
    content: [
      ...(message.content ? [{type: "text" as const, text: message.content}] : []),
      ...(message.calls ?? []).map((call) => ({
        type: "tool-call" as const,
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
      })),
    ],
  };
}

function toolCalls(
  calls: readonly {
    toolCallId: string;
    toolName: string;
    input: unknown;
    invalid?: boolean;
    error?: unknown;
    providerExecuted?: boolean;
  }[],
): ToolCall[] {
  return calls.map((call) => {
    if (call.providerExecuted)
      throw new ModelProtocolError("Provider-executed tools are not supported by this executor");
    return {
      id: call.toolCallId,
      name: call.toolName,
      input: jsonSchema.parse(call.input),
      ...(call.invalid
        ? {validationError: call.error instanceof Error ? call.error.message : "Invalid tool input"}
        : {}),
    };
  });
}
type Generation = {
  finishReason: string;
  text: string;
  calls: ToolCall[];
  output: unknown;
  usage?: ModelUsage;
};
type ChunkInfo = {step: number; signal: AbortSignal};

function settingsFor(
  options: ProviderOptions,
  request: ModelRequest,
  signal: AbortSignal,
): GenerateSettings {
  const caching = options.caching ?? true;
  const strictOutput = request.outputSchema ? strictSchema(request.outputSchema) : undefined;
  const tools: ToolSet = Object.fromEntries(
    request.tools.map((t) => {
      const strict = strictSchema(t.inputSchema);
      return [
        t.name,
        {
          description: t.description,
          inputSchema: aiSchema(strict ?? t.inputSchema),
          strict: strict !== undefined,
        },
      ];
    }),
  );
  return {
    model: options.model,
    // The instructions follow the tools, so one cache point covers both.
    instructions:
      caching && request.instructions
        ? {role: "system", content: request.instructions, providerOptions: CACHE_POINT}
        : request.instructions,
    messages: messages(request, caching),
    tools,
    maxOutputTokens: request.maxOutputTokens,
    maxRetries: 0,
    abortSignal: signal,
    providerOptions: request.outputSchema
      ? {
          ...options.providerOptions,
          openai: {
            strictJsonSchema: strictOutput !== undefined,
            ...options.providerOptions?.openai,
          },
        }
      : options.providerOptions,
    experimental_telemetry: options.telemetry,
    ...(request.outputSchema
      ? {output: Output.object({schema: aiSchema(strictOutput ?? request.outputSchema)})}
      : {}),
  };
}

async function generate(settings: GenerateSettings, wantsOutput: boolean): Promise<Generation> {
  const result = await generateText(settings);
  finished(result.finishReason);
  const calls = toolCalls(result.toolCalls);
  const output = wantsOutput && !calls.length ? result.output : undefined;
  return {
    finishReason: result.finishReason,
    text: result.text,
    calls,
    output,
    usage: modelUsage(result.usage),
  };
}

async function stream(
  settings: GenerateSettings,
  wantsOutput: boolean,
  options: ProviderOptions,
  info: ChunkInfo,
): Promise<Generation> {
  await options.onChunk?.({type: "start"}, info);
  const result = streamText(settings);
  for await (const part of result.fullStream) {
    if (part.type === "error") throw part.error;
    if (part.type === "text-delta" || part.type === "reasoning-delta") {
      await options.onChunk?.({type: part.type, text: part.text}, info);
    }
  }
  const finishReason = await result.finishReason;
  finished(finishReason);
  const text = await result.text;
  const calls = toolCalls(await result.toolCalls);
  const output = wantsOutput && !calls.length ? await result.output : undefined;
  const usage = modelUsage(await result.usage);
  await options.onChunk?.({type: "finish"}, info);
  return {finishReason, text, calls, output, usage};
}

/** Providers that report no counts leave usage out; compaction then estimates. */
function modelUsage(
  usage: Awaited<ReturnType<typeof generateText>>["usage"],
): ModelUsage | undefined {
  const {inputTokens, outputTokens} = usage;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cached = usage.inputTokenDetails?.cacheReadTokens;
  const written = usage.inputTokenDetails?.cacheWriteTokens;
  return {
    inputTokens,
    outputTokens,
    ...(cached ? {cachedInputTokens: cached} : {}),
    ...(written ? {cacheWriteInputTokens: written} : {}),
  };
}

/** AI SDK supplies provider protocols; Restate owns the loop, tools, and retries. */
export function aiModel(options: ProviderOptions): Model {
  async function complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const settings = settingsFor(options, request, signal);
    const wantsOutput = request.outputSchema !== undefined;
    try {
      const {finishReason, text, calls, output, usage} = options.onChunk
        ? await stream(settings, wantsOutput, options, {step: request.step ?? 0, signal})
        : await generate(settings, wantsOutput);
      if (finishReason === "tool-calls" && !calls.length)
        throw new ModelProtocolError("Model indicated tool calls but returned none");
      const reported = usage ? {usage} : {};
      if (calls.length) return {type: "tool_calls", calls, text, ...reported};
      return {
        type: "final",
        text,
        ...(output === undefined ? {} : {output: jsonSchema.parse(output)}),
        ...reported,
      };
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) {
        finished(error.finishReason);
        return {
          type: "final",
          text: error.text ?? "",
          validationError: "The response did not match the requested output schema.",
        };
      }
      // Restate owns retries. A missing API key, a feature the provider does not
      // support and a rejected request fail the same way on every attempt;
      // throttling and transient provider failures stay retryable.
      if (LoadAPIKeyError.isInstance(error) || UnsupportedFunctionalityError.isInstance(error))
        throw new TerminalError(error.message);
      // Use the SDK's parsed error code or HTTP 413, never provider-specific
      // message text. contextWindow avoids uncoded overflows up front.
      if (APICallError.isInstance(error) && contextOverflow(error))
        throw new ContextOverflowError(error.message);
      if (APICallError.isInstance(error) && !error.isRetryable)
        throw new TerminalError(error.message, {errorCode: error.statusCode});
      // Wait as long as the provider asks, so throttling does not use up the
      // retry attempts before its window has passed.
      const delay = APICallError.isInstance(error) ? retryAfter(error, options.model) : undefined;
      if (delay !== undefined) throw RetryableError.from(error, {retryAfter: delay});
      throw error;
    }
  }
  return journaledModel(
    (request, {signal}) => traceModel(options.tracer, request, () => complete(request, signal)),
    {name: "Ask model", retry: options.retry},
  );
}
/** Requests already contain JSON schemas, so no Zod objects cross this RPC. */
export function modelGateway(call: (request: ModelRequest) => ClientFuture<ModelResponse>): Model {
  return function* (request) {
    return yield* awaitChild(call(request));
  };
}
