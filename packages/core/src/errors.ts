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
export class AgentLimitError extends TerminalError {}
/** Invalid model output must not dispatch partial or ambiguous tool batches. */
export class ModelProtocolError extends TerminalError {
  constructor(message: string) {
    super(message);
    this.name = "ModelProtocolError";
  }
}
export function denial(result: GuardrailResult): string | undefined {
  if (typeof result === "string") return result;
  if (result === false) return "Rejected by guardrail";
  return undefined;
}
