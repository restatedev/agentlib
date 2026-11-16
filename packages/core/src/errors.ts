import {TerminalError} from "@restatedev/restate-sdk";
import {InterruptedError} from "@restatedev/restate-sdk-gen";

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
/** Reads a guardrail's result: nothing or `true` allows, a string or `false` rejects,
 * and an object whose only key is `replace` replaces. Anything else is a mistake rather
 * than a decision, so it fails instead of allowing. */
export function guardrailDecision(
  hook: string,
  result: unknown,
  replace?: string,
  fail: (message: string) => Error = (message) => new GuardrailError(message),
): {reject: string} | {replace: unknown} | undefined {
  if (result === undefined || result === true) return undefined;
  if (result === false) return {reject: "Rejected by guardrail"};
  if (typeof result === "string") return {reject: result || "Rejected by guardrail"};
  if (replace !== undefined && typeof result === "object" && result !== null) {
    const keys = Reflect.ownKeys(result);
    if (keys.length === 1 && keys[0] === replace)
      return {replace: (result as Record<string, unknown>)[replace]};
  }
  const choices = replace ? `a rejection reason, or {${replace}}` : "or a rejection reason";
  throw fail(`${hook} must return nothing, a boolean, ${choices}`);
}
