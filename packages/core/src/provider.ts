import {TerminalError} from "@restatedev/restate-sdk";
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
import {ContextOverflowError, ModelProtocolError, overflowResponse} from "./errors.js";
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
function messages(request: ModelRequest): ModelMessage[] {
  return request.messages.map((message) => {
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
  });
}

function toolCalls(
  calls: readonly {
    toolCallId: string;
    toolName: string;
    input: unknown;
    providerExecuted?: boolean;
  }[],
): ToolCall[] {
  return calls.map((call) => {
    if (call.providerExecuted)
      throw new ModelProtocolError("Provider-executed tools are not supported by this executor");
    return {id: call.toolCallId, name: call.toolName, input: jsonSchema.parse(call.input)};
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
    instructions: request.instructions,
    messages: messages(request),
    tools,
    maxOutputTokens: request.maxOutputTokens,
    maxRetries: 0,
    abortSignal: signal,
    providerOptions: options.providerOptions,
    experimental_telemetry: options.telemetry,
    ...(request.outputSchema
      ? {output: Output.object({schema: aiSchema(request.outputSchema)})}
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
  return {inputTokens, outputTokens, ...(cached ? {cachedInputTokens: cached} : {})};
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
      if (
        APICallError.isInstance(error) &&
        overflowResponse(error.statusCode, `${error.message} ${error.responseBody ?? ""}`)
      )
        throw new ContextOverflowError(error.message);
      if (APICallError.isInstance(error) && !error.isRetryable)
        throw new TerminalError(error.message, {errorCode: error.statusCode});
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
