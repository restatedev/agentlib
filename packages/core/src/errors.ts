import {TerminalError} from "@restatedev/restate-sdk";
import {InterruptedError} from "@restatedev/restate-sdk-gen";
import type {GuardrailResult} from "./types.js";

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
  return typeof result === "string"
    ? result
    : result === false
      ? "Rejected by guardrail"
      : undefined;
}
