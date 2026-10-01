import {TerminalError} from "@restatedev/restate-sdk";
import {InterruptedError} from "@restatedev/restate-sdk-gen";
import type {GuardrailResult} from "./types.js";

/** A present failure can contain any thrown value, including undefined. */
export type CapturedFailure = {error: unknown};

/** Explicit, model-recoverable tool failure. Other exceptions propagate. */
export class ToolError extends Error {
  constructor(
    message: string,
    public readonly code = "tool_error",
  ) {
    super(message);
    this.name = "ToolError";
  }
}
export class ToolDenied extends ToolError {}
export class ToolCancelled extends InterruptedError {}
export class RunInterrupted extends InterruptedError {}
export class GuardrailError extends TerminalError {}
/** A caller or stored history that can never run: retrying would fail the same way. */
export class RunInputError extends TerminalError {
  constructor(message: string) {
    super(message);
    this.name = "RunInputError";
  }
}
export class AgentLimitError extends TerminalError {}
/** Thrown by a tool to fail the whole run, rather than report a failure to the model. */
export class RunFailedError extends TerminalError {}
/** The run's tool-call budget is spent; the run stops instead of failing. */
export class ToolBudgetExceeded extends AgentLimitError {}
/** Invalid model output must not dispatch partial or ambiguous tool batches. */
export class ModelProtocolError extends TerminalError {
  constructor(message: string) {
    super(message);
    this.name = "ModelProtocolError";
  }
}
const CONTEXT_OVERFLOW_CODE = 413;
/** The model rejected a request as longer than its context window. It is
 * terminal, so the journal records it; its code identifies it on replay,
 * where the journaled failure comes back as a plain TerminalError. */
export class ContextOverflowError extends TerminalError {
  constructor(message: string) {
    super(message, {errorCode: CONTEXT_OVERFLOW_CODE});
    this.name = "ContextOverflowError";
  }
}
export function isContextOverflow(error: unknown): boolean {
  return error instanceof TerminalError && error.code === CONTEXT_OVERFLOW_CODE;
}
// How providers word it: OpenAI, Anthropic, Bedrock, Gemini and gateways in front of them.
const OVERFLOW_MESSAGE =
  /context[_ ]length|context window|maximum context|prompt is too long|input is too long|too many (input )?tokens|exceeds the maximum (number of )?(input )?tokens|request_too_large/i;
/** Whether a rejected request failed for its length: a 413, or a 400 that says so. */
export function overflowResponse(status: number | undefined, message: string): boolean {
  return status === 413 || (status === 400 && OVERFLOW_MESSAGE.test(message));
}

export function denial(result: GuardrailResult): string | undefined {
  if (typeof result === "string") return result;
  if (result === false) return "Rejected by guardrail";
  return undefined;
}
