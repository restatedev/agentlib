import {RetryableError, TerminalError} from "@restatedev/restate-sdk";
import type {ClientFuture, RetryOptions} from "@restatedev/restate-sdk-gen";
import {
  APICallError,
  generateText,
  InvalidToolInputError,
  JSONParseError,
  jsonSchema as aiSchema,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  Output,
  streamText,
  UnsupportedFunctionalityError,
  wrapLanguageModel,
  type AssistantModelMessage,
  type LanguageModel,
  type ModelMessage,
  type ProviderMetadata,
  type ToolSet,
} from "ai";
import type {Tracer} from "@opentelemetry/api";
import {ContextOverflowError, ModelResponseError} from "./errors.js";
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
  Reasoning,
  ToolCall,
} from "./types.js";

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
/** A response that stopped before it finished, for example at a content filter,
 * goes back to the model as a note, with another step to try again. A reply cut
 * off at the output token limit (`length`) is returned instead, as `cut_off`:
 * asking again would most likely be cut off again. */
function finished(reason: string | undefined, usage: ModelUsage | undefined) {
  if (reason === "stop" || reason === "tool-calls" || reason === "length") return;
  let message = `The response ended before it was complete (${reason ?? "unknown"}).`;
  if (reason === "content-filter") message = "The provider's content filter stopped the response.";
  throw new ModelResponseError(message, "incomplete_response", usage);
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
 * for Google models, `RetryInfo` in the body. A negative or infinite value
 * falls through to the next source. */
function retryAfter(error: APICallError, model: LanguageModel): number | undefined {
  const headers = error.responseHeaders ?? {};
  const header = headers["retry-after"] ?? "";
  const seconds = parseFloat(header);
  const google = typeof model !== "string" && model.provider.startsWith("google.");
  return (
    wait(parseFloat(headers["retry-after-ms"] ?? "")) ??
    wait(Number.isNaN(seconds) ? Date.parse(header) - Date.now() : seconds * 1000) ??
    (google ? wait(retryInfo(error.responseBody)) : undefined)
  );
}

const wait = (ms: number) => (Number.isFinite(ms) && ms >= 0 ? Math.ceil(ms) : undefined);

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
  // Reasoning goes back as the model produced it: first, and each tool call with its metadata.
  const {reasoning} = message;
  return {
    role: "assistant",
    content: [
      ...((reasoning?.items ?? []) as unknown as ReasoningPart[]),
      ...textParts(message.content, reasoning?.text),
      ...(message.calls ?? []).map((call) => {
        const metadata = reasoning?.calls?.[call.id];
        return {
          type: "tool-call" as const,
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
          ...(metadata ? {providerOptions: metadata as ProviderMetadata} : {}),
        };
      }),
    ],
  };
}

type ReasoningPart = Extract<
  Exclude<AssistantModelMessage["content"], string>[number],
  {type: "reasoning"}
>;

/** Replay signed text as returned by the model, including its original formatting. */
function textParts(
  content: string,
  parts: Reasoning["text"],
): Extract<Exclude<AssistantModelMessage["content"], string>[number], {type: "text"}>[] {
  if (!parts?.length) return content ? [{type: "text", text: content}] : [];
  return parts.map(({text, providerOptions}) => ({
    type: "text",
    text,
    ...(providerOptions ? {providerOptions: providerOptions as ProviderMetadata} : {}),
  }));
}

/** A response's reasoning, taken from the messages the AI SDK builds to send it back: the
 * reasoning parts as they are, and each tool call's provider options by call id. Its
 * tokens: the reported reasoning count, or for providers that report none, such as
 * Anthropic, the response's output, the closest bound. */
function responseReasoning(
  messages: readonly ModelMessage[],
  usage: Awaited<ReturnType<typeof generateText>>["usage"],
): Reasoning | undefined {
  const parts = messages.flatMap((m) =>
    m.role === "assistant" && typeof m.content !== "string" ? m.content : [],
  );
  const items = parts.filter((part) => part.type === "reasoning");
  const calls = Object.fromEntries(
    parts.flatMap((part) =>
      part.type === "tool-call" && part.providerOptions
        ? [[part.toolCallId, part.providerOptions]]
        : [],
    ),
  );
  const hasCalls = Object.keys(calls).length > 0;
  // Gemini can sign ordinary text, including the final answer. Keep every text
  // part with its text if any part has a signature. Message IDs aren't reasoning metadata:
  // replaying an OpenAI text itemId with store:true would restore the original
  // answer even if an output policy had replaced it.
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => {
      const providerOptions = Object.fromEntries(
        Object.entries(part.providerOptions ?? {}).filter(
          ([, options]) => typeof options.thoughtSignature === "string",
        ),
      );
      return {
        text: part.text,
        ...(Object.keys(providerOptions).length ? {providerOptions} : {}),
      };
    });
  const hasText = text.some((part) => part.providerOptions !== undefined);
  if (!items.length && !hasCalls && !hasText) return undefined;
  const tokens =
    usage.outputTokenDetails?.reasoningTokens || (items.length ? usage.outputTokens : undefined);
  const reasoning = {
    items,
    ...(hasCalls ? {calls} : {}),
    ...(hasText ? {text} : {}),
    ...(tokens ? {tokens} : {}),
  };
  // As the journal stores it: JSON, without undefined fields.
  const parsed = jsonSchema.safeParse(JSON.parse(JSON.stringify(reasoning)));
  return parsed.success ? (parsed.data as Reasoning) : undefined;
}

type SdkToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  invalid?: boolean;
  error?: unknown;
  providerExecuted?: boolean;
};

/** Whether a call's arguments are not JSON, as when the reply was cut off part way through them. */
function unparsed(call: SdkToolCall): boolean {
  return (
    call.invalid === true &&
    InvalidToolInputError.isInstance(call.error) &&
    JSONParseError.isInstance(call.error.cause)
  );
}

/** The response's tool calls. A cut-off reply keeps only the calls whose arguments are complete. */
function toolCalls(calls: readonly SdkToolCall[], cutOff: boolean): ToolCall[] {
  return calls.flatMap((call) => {
    if (call.providerExecuted)
      throw new UnsupportedFunctionalityError({
        functionality: "provider-executed tools",
        message: "Provider-executed tools are not supported by this executor",
      });
    if (cutOff && unparsed(call)) return [];
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
  reasoning?: Reasoning;
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
  // Schemas go to AI SDK as they are, with its defaults for strict mode.
  const tools: ToolSet = Object.fromEntries(
    request.tools.map((t) => [
      t.name,
      {description: t.description, inputSchema: aiSchema(t.inputSchema)},
    ]),
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
    // Unset, the provider picks the limit.
    ...(request.maxOutputTokens === undefined ? {} : {maxOutputTokens: request.maxOutputTokens}),
    maxRetries: 0,
    abortSignal: signal,
    // OpenAI keeps nothing: its reasoning comes back encrypted and lives in the history,
    // so it never depends on what OpenAI stores and deletes. The caller's options win.
    providerOptions: {
      ...options.providerOptions,
      openai: {store: false, ...options.providerOptions?.openai},
    },
    experimental_telemetry: options.telemetry,
    ...(request.outputSchema
      ? {output: Output.object({schema: aiSchema(request.outputSchema)})}
      : {}),
  };
}

/** Whether a reply was cut off at the output token limit. Some providers report
 * another finish reason for a reply cut off inside a tool call, with the call's
 * arguments closed early into valid JSON (DeepInfra, streaming, reports
 * `tool_calls`), so a reply that used the whole limit counts as cut off too:
 * its calls never run. */
function reachedLimit(
  reason: string | undefined,
  settings: GenerateSettings,
  usage: ModelUsage | undefined,
) {
  if (reason === "length") return true;
  const limit = settings.maxOutputTokens;
  return limit !== undefined && usage !== undefined && usage.outputTokens >= limit;
}

async function generate(settings: GenerateSettings, wantsOutput: boolean): Promise<Generation> {
  const result = await generateText(settings);
  const usage = modelUsage(result.usage);
  finished(result.finishReason, usage);
  const cutOff = reachedLimit(result.finishReason, settings, usage);
  const calls = toolCalls(result.toolCalls, cutOff);
  // A cut-off reply's output is incomplete, so it is never parsed.
  const output = wantsOutput && !cutOff && !calls.length ? result.output : undefined;
  return {
    finishReason: cutOff ? "length" : result.finishReason,
    text: result.text,
    calls,
    reasoning: responseReasoning(result.responseMessages, result.usage),
    output,
    usage,
  };
}

async function stream(
  settings: GenerateSettings,
  wantsOutput: boolean,
  options: ProviderOptions,
  info: ChunkInfo,
): Promise<Generation> {
  await options.onChunk?.({type: "start"}, info);
  const result = streamText({...settings, model: preserveGeminiTextMetadata(settings.model)});
  for await (const part of result.fullStream) {
    if (part.type === "error") throw part.error;
    if (part.type === "text-delta" || part.type === "reasoning-delta") {
      await options.onChunk?.({type: part.type, text: part.text}, info);
    }
  }
  const finishReason = await result.finishReason;
  const rawUsage = await result.usage;
  const usage = modelUsage(rawUsage);
  finished(finishReason, usage);
  const cutOff = reachedLimit(finishReason, settings, usage);
  const text = await result.text;
  const calls = toolCalls(await result.toolCalls, cutOff);
  const output = wantsOutput && !cutOff && !calls.length ? await result.output : undefined;
  const reasoning = responseReasoning(await result.responseMessages, rawUsage);
  await options.onChunk?.({type: "finish"}, info);
  return {finishReason: cutOff ? "length" : finishReason, text, calls, reasoning, output, usage};
}

/** Gemini reuses a text-block ID across signed segments. Give each segment its
 * own start/end pair so AI SDK aggregation keeps its text and signature together.
 * Empty trailing deltas sign the preceding text; carry their metadata onto text-end
 * because AI SDK 7.0.26 filters empty deltas before building responseMessages. */
function preserveGeminiTextMetadata(model: LanguageModel): LanguageModel {
  // String model IDs are resolved internally by the SDK's configured gateway.
  // Only Google's adapters (including Vertex) need this stream workaround.
  if (typeof model === "string" || !model.provider.startsWith("google.")) return model;
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      async wrapStream({doStream}) {
        const result = await doStream();
        const blocks = new Map<string, {metadata?: ProviderMetadata; hasText: boolean}>();
        const signed = (metadata?: ProviderMetadata) =>
          Object.values(metadata ?? {}).some(
            (options) => typeof options.thoughtSignature === "string",
          );
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                if (chunk.type === "text-start")
                  blocks.set(chunk.id, {metadata: chunk.providerMetadata, hasText: false});
                if (chunk.type === "text-delta") {
                  const block = blocks.get(chunk.id);
                  if (block) {
                    if (
                      chunk.delta.length > 0 &&
                      block.hasText &&
                      (signed(block.metadata) || signed(chunk.providerMetadata))
                    ) {
                      controller.enqueue({
                        type: "text-end",
                        id: chunk.id,
                        providerMetadata: block.metadata,
                      });
                      // The SDK's output transform also remembers metadata by ID.
                      // Explicitly clear it when the next segment is unsigned.
                      chunk = {...chunk, providerMetadata: chunk.providerMetadata ?? {}};
                      controller.enqueue({
                        type: "text-start",
                        id: chunk.id,
                        providerMetadata: chunk.providerMetadata,
                      });
                      block.metadata = undefined;
                      block.hasText = false;
                    }
                    block.metadata = chunk.providerMetadata ?? block.metadata;
                    block.hasText ||= chunk.delta.length > 0;
                  }
                }
                if (chunk.type === "text-end") {
                  const previous = blocks.get(chunk.id)?.metadata;
                  if (previous)
                    chunk = {...chunk, providerMetadata: {...previous, ...chunk.providerMetadata}};
                  blocks.delete(chunk.id);
                }
                controller.enqueue(chunk);
              },
            }),
          ),
        };
      },
    },
  });
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
      const {finishReason, text, calls, reasoning, output, usage} = options.onChunk
        ? await stream(settings, wantsOutput, options, {step: request.step ?? 0, signal})
        : await generate(settings, wantsOutput);
      const reported = {...(usage ? {usage} : {}), ...(reasoning ? {reasoning} : {})};
      // Journaled as the step's result, so a replay ends the run the same way.
      if (finishReason === "length")
        return {type: "cut_off", text, ...(calls.length ? {calls} : {}), ...reported};
      if (finishReason === "tool-calls" && !calls.length)
        throw new ModelResponseError(
          "The response announced tool calls but contained none. Call a tool, or respond with text.",
          "invalid_response",
          usage,
        );
      if (calls.length) return {type: "tool_calls", calls, text, ...reported};
      return {
        type: "final",
        text,
        ...(output === undefined ? {} : {output: jsonSchema.parse(output)}),
        ...reported,
      };
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) {
        const usage = error.usage && modelUsage(error.usage);
        finished(error.finishReason, usage);
        const text = error.text ?? "";
        // generateText parses the output before generate() can check the limit,
        // so output cut off with another finish reason arrives here.
        if (reachedLimit(error.finishReason, settings, usage))
          return {type: "cut_off", text, ...(usage ? {usage} : {})};
        return {
          type: "final",
          text,
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
    {retry: options.retry},
  );
}
/** Requests already contain JSON schemas, so no Zod objects cross this RPC. */
export function modelGateway(call: (request: ModelRequest) => ClientFuture<ModelResponse>): Model {
  return function* (request) {
    return yield* awaitChild(call(request));
  };
}
