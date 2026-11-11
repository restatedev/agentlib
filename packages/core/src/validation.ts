import {z} from "zod";
import {ModelProtocolError, RunInputError, ToolError} from "./errors.js";
import type {JsonValue, Message, ModelResponse, ReadonlyMessage} from "./types.js";

export const jsonSchema = z.json();
export const steeringUpdate = z.object({
  message: z.string().refine((message) => message.trim().length > 0),
  data: jsonSchema.optional(),
});
const callSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: jsonSchema,
  validationError: z.string().min(1).optional(),
});
const toolResultSchema = z.discriminatedUnion("status", [
  z.object({status: z.literal("success"), output: jsonSchema}),
  z.object({status: z.literal("error"), code: z.string(), message: z.string()}),
  z.object({status: z.enum(["denied", "cancelled"]), message: z.string()}),
  z.object({status: z.literal("pending"), operationId: z.string()}),
]);
const messageSchema = z.discriminatedUnion("role", [
  z.object({role: z.literal("user"), content: z.string()}),
  z.object({
    role: z.literal("assistant"),
    content: z.string(),
    calls: z.array(callSchema).min(1).optional(),
  }),
  z.object({
    role: z.literal("tool"),
    callId: z.string(),
    name: z.string(),
    result: toolResultSchema,
  }),
]);
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  cacheWriteInputTokens: z.number().int().nonnegative().optional(),
});
const responseSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("final"),
      text: z.string(),
      output: jsonSchema.optional(),
      validationError: z.string().optional(),
      usage: usageSchema.optional(),
    })
    .refine(
      (value) =>
        value.text.trim().length > 0 || value.output !== undefined || !!value.validationError,
    ),
  z.object({
    type: z.literal("tool_calls"),
    calls: z.array(callSchema).min(1),
    text: z.string().optional(),
    usage: usageSchema.optional(),
  }),
]);

export function modelResponse(value: unknown): ModelResponse {
  const result = responseSchema.safeParse(value);
  if (!result.success)
    throw new ModelProtocolError("Model returned an invalid response or empty tool batch");
  return result.data;
}

/** Tool output must be JSON. Anything else goes back to the model instead of being retried. */
export function toolOutput(value: unknown): JsonValue {
  const result = jsonSchema.safeParse(value);
  if (!result.success) throw new ToolError("Tool output must be JSON", "invalid_output");
  return result.data;
}

/** Clone and reject incomplete histories before making any model call. */
export function history(value: readonly Message[]): Message[] {
  const parsed = z.array(messageSchema).safeParse(value);
  if (!parsed.success) throw new RunInputError(`Invalid history: ${parsed.error.message}`);
  checkProtocol(parsed.data);
  return parsed.data;
}

/** Rejects a history whose tool results do not answer the calls before them, in
 * order. Structural only: callers pass messages that were already validated. */
export function checkProtocol(messages: readonly Message[]): void {
  const ids = new Set<string>();
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (pending.get(message.callId) !== message.name) {
        throw new RunInputError("History contains an unmatched or duplicate tool result");
      }
      pending.delete(message.callId);
      continue;
    }
    if (pending.size > 0)
      throw new RunInputError("History must answer every tool call before the next message");
    if (message.role === "assistant") {
      for (const call of message.calls ?? []) {
        if (ids.has(call.id)) throw new RunInputError("History contains duplicate tool-call IDs");
        ids.add(call.id);
        pending.set(call.id, call.name);
      }
    }
  }
  if (pending.size > 0) throw new RunInputError("History contains unfinished tool calls");
}

/** The messages a `beforeStep` hook returned for one request. Messages it kept from
 * the request were validated when they were recorded; only new ones are parsed. */
export function stepMessages(
  sent: readonly Message[],
  returned: readonly ReadonlyMessage[],
): Message[] {
  if (!Array.isArray(returned)) throw new RunInputError("beforeStep must return a messages array");
  const recorded = new Set<unknown>(sent);
  const messages = returned.map((message) => {
    if (recorded.has(message)) return message as Message;
    const parsed = messageSchema.safeParse(message);
    if (!parsed.success)
      throw new RunInputError(`beforeStep returned an invalid message: ${parsed.error.message}`);
    return parsed.data;
  });
  checkProtocol(messages);
  return messages;
}
