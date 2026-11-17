import {CancelledError, TerminalError} from "@restatedev/restate-sdk";
import {InterruptedError} from "@restatedev/restate-sdk-gen";

/** A present failure can contain any thrown value, including undefined. */
export type CapturedFailure = {error: unknown};

// A journaled step or an RPC rebuilds a failure as a plain TerminalError with its
// message, code and metadata, never its class. The run therefore reads what an
// error means from its metadata. Error metadata requires Restate 1.6 or later.
const KIND = "agentlib.kind";
const CODE = "agentlib.code";
const USAGE = "agentlib.usage";

/** Stops the agent run instead of reaching the model. Throw it from a tool, a hook,
 * or a handler a tool calls: every agent run it passes through fails, and so does
 * the handler, unless it catches the error. Restate never retries it. */
export class AgentTerminalError extends TerminalError {
  constructor(message: string, options: {errorCode?: number} = {}) {
    super(message, {errorCode: options.errorCode, metadata: {[KIND]: "agent-terminal"}});
    this.name = "AgentTerminalError";
  }
}

/** @deprecated Use `AgentTerminalError`. */
export const RunFailedError = AgentTerminalError;
/** @deprecated Use `AgentTerminalError`. */
export type RunFailedError = AgentTerminalError;

/** A failure the model receives with a code it can act on, such as `not_found`.
 * Like any `TerminalError`, Restate never retries it, and inside a run the agent
 * gives it to the model: as the tool call's result, or as a note before the
 * model's next step. Outside a run, it's an ordinary terminal error. */
export class ToolError extends TerminalError {
  /** The code the model receives. `code` is the numeric status every `TerminalError` has. */
  readonly toolCode: string;
  constructor(message: string, code = "tool_error") {
    super(message, {metadata: {[CODE]: code}});
    this.name = "ToolError";
    this.toolCode = code;
  }
}
/** A tool call's rejection: the call's result has status `denied`. */
export class ToolDenied extends ToolError {
  constructor(message: string) {
    super(message, "denied");
  }
}
export class ToolCancelled extends InterruptedError {}
export class RunInterrupted extends InterruptedError {}
/** A caller or stored history that can never run: retrying would fail the same way. */
export class RunInputError extends TerminalError {
  constructor(message: string) {
    super(message);
    this.name = "RunInputError";
  }
}
/** The run's tool-call budget is spent; the run stops instead of failing. */
export class ToolBudgetExceeded extends TerminalError {
  constructor(message: string) {
    super(message);
    this.name = "ToolBudgetExceeded";
  }
}
/** A response the model can fix by trying again: cut off, empty, or claiming tool
 * calls without any. A model adapter throws it inside its journaled call, so the
 * journal records it with the usage the response reported, and a replay repeats
 * the same step without calling the provider. */
export class ModelResponseError extends TerminalError {
  constructor(message: string, code: "invalid_response" | "incomplete_response", usage?: unknown) {
    const metadata: Record<string, string> = {[KIND]: "model-response", [CODE]: code};
    if (usage !== undefined) metadata[USAGE] = JSON.stringify(usage);
    super(message, {metadata});
    this.name = "ModelResponseError";
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
/** Whether `error` reports a context overflow. An `AgentTerminalError` never
 * does, whatever its code, because the run must not recover from it. */
export function isContextOverflow(error: unknown): boolean {
  return (
    error instanceof TerminalError &&
    error.code === CONTEXT_OVERFLOW_CODE &&
    !isAgentTerminal(error)
  );
}

const metadataOf = (error: unknown) =>
  error instanceof TerminalError ? error.metadata : undefined;

/** Whether `error` is an `AgentTerminalError`, also after a journaled step or an
 * RPC rebuilt it as a plain `TerminalError`. */
export function isAgentTerminal(error: unknown): error is TerminalError {
  return metadataOf(error)?.[KIND] === "agent-terminal";
}

/** Whether the model can fix the response that failed with `error` by trying again. */
export function isResponseProblem(error: unknown): error is TerminalError {
  return metadataOf(error)?.[KIND] === "model-response";
}

/** The code the model receives for `error`: a `ToolError`'s, also after a journaled
 * step or an RPC rebuilt it; otherwise undefined. */
export function toolErrorCode(error: unknown): string | undefined {
  return metadataOf(error)?.[CODE];
}

/** The usage a model call reported before it failed with a `ModelResponseError`. */
export function failedCallUsage(error: unknown): unknown {
  const usage = metadataOf(error)?.[USAGE];
  if (usage === undefined) return undefined;
  try {
    return JSON.parse(usage) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether a fallback must let `error` through: cancellation, and an
 * `AgentTerminalError`, which stops the run wherever it is thrown. */
export function mustPropagate(error: unknown): boolean {
  return (
    error instanceof InterruptedError || error instanceof CancelledError || isAgentTerminal(error)
  );
}

/** Whether the model receives `error`: any `TerminalError` except cancellation, an
 * `AgentTerminalError`, and the run's spent tool budget, which the run handles. */
export function reachesModel(error: unknown): error is TerminalError {
  return (
    error instanceof TerminalError &&
    !(error instanceof CancelledError) &&
    !(error instanceof ToolBudgetExceeded) &&
    !isAgentTerminal(error)
  );
}

/** Reads a guardrail's result: nothing or `true` allows, a string or `false` rejects,
 * and an object whose only key is `replace` replaces. Anything else is a mistake in
 * the hook rather than a decision. It fails with a `TypeError`, which Restate retries,
 * so the invocation can continue once a fix is deployed. */
export function guardrailDecision(
  hook: string,
  result: unknown,
  replace?: string,
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
  throw new TypeError(`${hook} must return nothing, a boolean, ${choices}`);
}
