import OpenAI from "openai";
import {TerminalError} from "@restatedev/restate-sdk";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type {RetryOptions} from "@restatedev/restate-sdk-gen";
import {ModelProtocolError} from "./errors.js";
import {journaledModel} from "./model.js";
import type {Model, ModelRequest, ToolCall} from "./types.js";

export type OpenAIModelOptions = {
  model: string;
  client?: OpenAI;
  retry?: RetryOptions;
  /** GPT-5.6 Chat Completions tool requests default to reasoning_effort: "none".
   * Explicit settings are preserved; use Responses for reasoning with tools. */
  settings?: Pick<
    ChatCompletionCreateParamsNonStreaming,
    "temperature" | "max_completion_tokens" | "reasoning_effort" | "verbosity" | "service_tier"
  >;
};

/** Optional Chat Completions adapter. Importing/defining it needs no credentials. */
export function openAIModel(options: OpenAIModelOptions): Model {
  if (!options.model.trim()) throw new TypeError("A model name is required");
  const {model, retry, settings = {}} = options;
  const parameters = {...settings};
  let client = options.client;
  return journaledModel(
    async (request, {signal}) => {
      client ??= new OpenAI();
      const completion = await client.chat.completions
        .create(
          {
            ...parameters,
            model,
            ...(request.tools.length && /^gpt-5\.6(?:$|-)/.test(model)
              ? {reasoning_effort: parameters.reasoning_effort ?? "none"}
              : {}),
            max_completion_tokens: parameters.max_completion_tokens ?? request.maxOutputTokens,
            ...(request.outputSchema
              ? {
                  response_format: {
                    type: "json_schema" as const,
                    json_schema: {
                      name: "agent_output",
                      schema: request.outputSchema,
                      strict: false,
                    },
                  },
                }
              : {}),
            messages: render(request),
            ...(request.tools.length
              ? {
                  tools: request.tools.map(({name, description, inputSchema}) => ({
                    type: "function" as const,
                    function: {name, description, parameters: inputSchema, strict: false},
                  })),
                }
              : {}),
          },
          {signal, maxRetries: 0},
        )
        .catch((error: unknown) => {
          // Restate owns retries, but invalid requests/credentials do not improve
          // on retry. Keep connection failures, rate limits and server errors retryable.
          if (
            error instanceof OpenAI.APIError &&
            error.status !== undefined &&
            error.status >= 400 &&
            error.status < 500 &&
            ![408, 409, 429].includes(error.status)
          ) {
            throw new TerminalError(error.message);
          }
          throw error;
        });

      const choice = completion.choices[0];
      if (!choice || !["stop", "tool_calls"].includes(choice.finish_reason)) {
        throw new ModelProtocolError(
          `Incomplete model response: ${choice?.finish_reason ?? "no choices"}`,
        );
      }
      if (choice.message.refusal)
        throw new ModelProtocolError(`Model refused the request: ${choice.message.refusal}`);
      const calls: ToolCall[] = (choice.message.tool_calls ?? []).map((call) => {
        if (call.type !== "function")
          throw new ModelProtocolError("Unsupported model tool-call type");
        let input: ToolCall["input"];
        try {
          input = JSON.parse(call.function.arguments);
        } catch {
          throw new ModelProtocolError(`Invalid JSON arguments for tool ${call.function.name}`);
        }
        return {id: call.id, name: call.function.name, input};
      });
      if (choice.finish_reason === "tool_calls" && calls.length === 0) {
        throw new ModelProtocolError("Model indicated tool calls but returned none");
      }
      return calls.length > 0
        ? {
            type: "tool_calls",
            calls,
            ...(choice.message.content ? {text: choice.message.content} : {}),
          }
        : {type: "final", text: choice.message.content ?? ""};
    },
    {name: `Ask model: ${model}`, ...(retry ? {retry} : {})},
  );
}

function render(request: ModelRequest): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];
  if (request.instructions) result.push({role: "system", content: request.instructions});
  for (const message of request.messages) {
    if (message.role === "user") result.push(message);
    else if (message.role === "tool") {
      result.push({
        role: "tool",
        tool_call_id: message.callId,
        content: JSON.stringify(message.result),
      });
    } else {
      result.push({
        role: "assistant",
        content: message.content,
        ...(message.calls
          ? {
              tool_calls: message.calls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: {name: call.name, arguments: JSON.stringify(call.input)},
              })),
            }
          : {}),
      });
    }
  }
  return result;
}
