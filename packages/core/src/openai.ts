import OpenAI from "openai";
import {TerminalError} from "@restatedev/restate-sdk";
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type {RetryOptions} from "@restatedev/restate-sdk-gen";
import {ModelProtocolError} from "./errors.js";
import {journaledModel} from "./model.js";
import type {Model, ModelRequest, ModelResponse, ToolCall} from "./types.js";
import {strictSchema} from "./strict-schema.js";

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
  const {model, retry} = options;
  let client = options.client;
  return journaledModel(
    async (request, {signal}) => {
      client ??= new OpenAI();
      const completion = await client.chat.completions
        .create(payload(options, request), {signal, maxRetries: 0})
        .catch(classifyError);
      return parseCompletion(completion);
    },
    {name: `Ask model: ${model}`, retry},
  );
}

function payload(
  {model, settings = {}}: OpenAIModelOptions,
  request: ModelRequest,
): ChatCompletionCreateParamsNonStreaming {
  const body: ChatCompletionCreateParamsNonStreaming = {
    ...settings,
    model,
    max_completion_tokens: settings.max_completion_tokens ?? request.maxOutputTokens,
    messages: render(request),
  };
  if (request.tools.length) {
    if (/^gpt-5\.6(?:$|-)/.test(model)) body.reasoning_effort = settings.reasoning_effort ?? "none";
    body.tools = request.tools.map(({name, description, inputSchema}) => {
      const strict = strictSchema(inputSchema);
      return {
        type: "function",
        function: {name, description, parameters: strict ?? inputSchema, strict: !!strict},
      };
    });
  }
  if (request.outputSchema) {
    const strict = strictSchema(request.outputSchema);
    body.response_format = {
      type: "json_schema",
      json_schema: {name: "agent_output", schema: strict ?? request.outputSchema, strict: !!strict},
    };
  }
  return body;
}

/** Restate owns retries, but invalid requests/credentials do not improve on
 * retry. Connection failures, rate limits and server errors stay retryable. */
function classifyError(error: unknown): never {
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
}

function parseCompletion(completion: ChatCompletion): ModelResponse {
  const choice = completion.choices[0];
  if (!choice || !["stop", "tool_calls"].includes(choice.finish_reason)) {
    throw new ModelProtocolError(
      `Incomplete model response: ${choice?.finish_reason ?? "no choices"}`,
    );
  }
  const {message} = choice;
  if (message.refusal)
    throw new ModelProtocolError(`Model refused the request: ${message.refusal}`);
  const calls: ToolCall[] = (message.tool_calls ?? []).map((call) => {
    if (call.type !== "function") throw new ModelProtocolError("Unsupported model tool-call type");
    let input: ToolCall["input"];
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      throw new ModelProtocolError(`Invalid JSON arguments for tool ${call.function.name}`);
    }
    return {id: call.id, name: call.function.name, input};
  });
  if (choice.finish_reason === "tool_calls" && calls.length === 0)
    throw new ModelProtocolError("Model indicated tool calls but returned none");
  if (calls.length > 0)
    return {type: "tool_calls", calls, ...(message.content ? {text: message.content} : {})};
  return {type: "final", text: message.content ?? ""};
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
      const assistant: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: message.content,
      };
      if (message.calls) {
        assistant.tool_calls = message.calls.map((call) => ({
          id: call.id,
          type: "function",
          function: {name: call.name, arguments: JSON.stringify(call.input)},
        }));
      }
      result.push(assistant);
    }
  }
  return result;
}
