import {TerminalError} from "@restatedev/restate-sdk";
import type {ClientFuture, RetryOptions} from "@restatedev/restate-sdk-gen";
import {
  APICallError,
  generateText,
  jsonSchema as aiSchema,
  NoObjectGeneratedError,
  Output,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import type {Tracer} from "@opentelemetry/api";
import {ModelProtocolError} from "./errors.js";
import {journaledModel} from "./model.js";
import {awaitChild} from "./tool.js";
import {traceModel} from "./telemetry.js";
import {jsonSchema} from "./validation.js";
import type {Model, ModelChunk, ModelRequest, ModelResponse, ToolCall} from "./types.js";

type GenerateSettings = Parameters<typeof generateText>[0];

export type ProviderOptions = {
  model: LanguageModel;
  retry?: RetryOptions;
  providerOptions?: GenerateSettings["providerOptions"];
  telemetry?: GenerateSettings["experimental_telemetry"];
  tracer?: Tracer;
  includeChunks?: boolean;
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
/** AI SDK supplies provider protocols; Restate owns the loop, tools, and retries. */
export function aiModel(options: ProviderOptions): Model {
  return journaledModel(
    async (request, {signal}) =>
      traceModel(options.tracer, request, async () => {
        const tools: ToolSet = Object.fromEntries(
          request.tools.map((t) => [
            t.name,
            {description: t.description, inputSchema: aiSchema(t.inputSchema), strict: false},
          ]),
        );
        const settings: GenerateSettings = {
          model: options.model,
          instructions: request.instructions,
          messages: messages(request),
          tools,
          maxOutputTokens: request.maxOutputTokens,
          maxRetries: 0,
          abortSignal: signal,
          providerOptions: options.providerOptions,
          experimental_telemetry: options.telemetry,
        };
        if (request.outputSchema) {
          settings.output = Output.object({schema: aiSchema(request.outputSchema)});
        }
        const chunks: ModelChunk[] = [];
        const info = {step: request.step ?? 0, signal};
        try {
          let text: string, calls: ToolCall[], output: unknown, finishReason: string;
          if (options.onChunk || options.includeChunks) {
            await options.onChunk?.({type: "start"}, info);
            const result = streamText(settings);
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error;
              if (part.type === "text-delta" || part.type === "reasoning-delta") {
                const chunk = {type: part.type, text: part.text};
                if (options.includeChunks) chunks.push(chunk);
                await options.onChunk?.(chunk, info);
              }
            }
            finishReason = await result.finishReason;
            finished(finishReason);
            text = await result.text;
            calls = toolCalls(await result.toolCalls);
            output = request.outputSchema && !calls.length ? await result.output : undefined;
            await options.onChunk?.({type: "finish"}, info);
          } else {
            const result = await generateText(settings);
            finishReason = result.finishReason;
            finished(finishReason);
            text = result.text;
            calls = toolCalls(result.toolCalls);
            output = request.outputSchema && !calls.length ? result.output : undefined;
          }
          if (finishReason === "tool-calls" && !calls.length)
            throw new ModelProtocolError("Model indicated tool calls but returned none");
          if (calls.length) {
            return {type: "tool_calls", calls, text, ...(options.includeChunks ? {chunks} : {})};
          }
          return {
            type: "final",
            text,
            ...(output === undefined ? {} : {output: jsonSchema.parse(output)}),
            ...(options.includeChunks ? {chunks} : {}),
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
          if (APICallError.isInstance(error) && !error.isRetryable)
            throw new TerminalError(error.message);
          throw error;
        }
      }),
    {name: "agent-model", retry: options.retry},
  );
}
/** Requests already contain JSON schemas, so no Zod objects cross this RPC. */
export function modelGateway(call: (request: ModelRequest) => ClientFuture<ModelResponse>): Model {
  return function* (request) {
    return yield* awaitChild(call(request));
  };
}
