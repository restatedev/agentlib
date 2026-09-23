import {z} from "zod";
import {ModelProtocolError} from "./errors.js";
import type {Message, ModelResponse} from "./types.js";

export const jsonSchema = z.json();
const callSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: jsonSchema,
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
const responseSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("final"),
      text: z.string(),
      output: jsonSchema.optional(),
      validationError: z.string().optional(),
    })
    .refine(
      (value) =>
        value.text.trim().length > 0 || value.output !== undefined || !!value.validationError,
    ),
  z.object({
    type: z.literal("tool_calls"),
    calls: z.array(callSchema).min(1),
    text: z.string().optional(),
  }),
]);

export function modelResponse(value: unknown): ModelResponse {
  const result = responseSchema.safeParse(value);
  if (!result.success)
    throw new ModelProtocolError("Model returned an invalid response or empty tool batch");
  return result.data;
}

/** Clone and reject incomplete histories before making any model call. */
export function history(value: readonly Message[]): Message[] {
  const messages = z.array(messageSchema).parse(value);
  const ids = new Set<string>();
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (pending.get(message.callId) !== message.name) {
        throw new TypeError("History contains an unmatched or duplicate tool result");
      }
      pending.delete(message.callId);
      continue;
    }
    if (pending.size > 0)
      throw new TypeError("History must answer every tool call before the next message");
    if (message.role === "assistant") {
      for (const call of message.calls ?? []) {
        if (ids.has(call.id)) throw new TypeError("History contains duplicate tool-call IDs");
        ids.add(call.id);
        pending.set(call.id, call.name);
      }
    }
  }
  if (pending.size > 0) throw new TypeError("History contains unfinished tool calls");
  return messages;
}
