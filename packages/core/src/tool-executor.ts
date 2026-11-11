import {CancelledError, TerminalError} from "@restatedev/restate-sdk";
import {
  InterruptedError,
  run as journal,
  signal,
  type Operation,
} from "@restatedev/restate-sdk-gen";
import {
  AgentLimitError,
  guardrailDecision,
  RunFailedError,
  RunInterrupted,
  ToolBudgetExceeded,
  ToolCancelled,
  ToolDenied,
  ToolError,
} from "./errors.js";
import type {
  AgentRuntime,
  ApprovalHandler,
  ApprovalRequest,
  JsonValue,
  ProgressEvent,
  RunContext,
  Tool,
  ToolCall,
  ToolContext,
  ToolInfo,
  ToolResult,
} from "./types.js";
import type {ToolCatalog} from "./tool-catalog.js";
import {jsonSchema, toolOutput} from "./validation.js";

export type ToolExecutionLimits = Readonly<{
  maxToolCalls: number;
  maxToolDepth: number;
  maxOutputChars: number;
}>;

type ToolExecutorOptions<C> = ToolExecutionLimits & {
  root: AgentRuntime<C>;
  context: RunContext<C>;
  onApproval?: ApprovalHandler<C>;
  progress: (event: ProgressEvent) => Operation<void>;
  cancelOperation: ToolContext<C>["cancelOperation"];
};

/** One executor per run: nested calls and handoffs share budgets and root policies.
 * Each call keeps its launching agent and catalog, even after a later handoff. */
export function createToolExecutor<C>({
  root,
  context,
  maxToolCalls,
  maxToolDepth,
  maxOutputChars,
  onApproval,
  progress,
  cancelOperation,
}: ToolExecutorOptions<C>) {
  let calls = 0;

  function* executeCall(
    call: ToolCall,
    callStep: number,
    owner: AgentRuntime<C>,
    registry: ToolCatalog<C>,
    depth = 0,
  ): Operation<ToolResult> {
    if (++calls > maxToolCalls) throw new ToolBudgetExceeded("Maximum tool calls reached");
    if (depth > maxToolDepth) throw new AgentLimitError("Maximum nested tool depth exceeded");
    const definition = registry.registry.get(call.name);
    if (!definition)
      return {status: "error", code: "unknown_tool", message: `Unknown tool: ${call.name}`};
    // A progress handler can wait, so cancellation can land while it reports.
    let outcome: {result: ToolResult; info: ToolInfo};
    try {
      yield* progress({
        type: "tool-start",
        callId: call.id,
        name: call.name,
        input: call.input,
        ...(definition.info ? {info: structuredClone(definition.info)} : {}),
      });
      if (call.validationError) throw new ToolError(call.validationError, "invalid_input");
      outcome = yield* runCall(call, callStep, owner, registry, definition, depth);
    } catch (error) {
      // Invalid input and interruptions become tool results; retryable failures propagate.
      outcome = {result: failedResult(error), info: {name: call.name, details: call.input}};
    }
    const {result, info} = outcome;
    try {
      yield* progress({type: "tool-end", callId: call.id, name: call.name, result, info});
    } catch (error) {
      // The call has settled; interrupting its report does not undo its effects.
      if (!(error instanceof InterruptedError)) throw error;
    }
    return result;
  }

  function* runCall(
    call: ToolCall,
    callStep: number,
    owner: AgentRuntime<C>,
    registry: ToolCatalog<C>,
    definition: Tool<C>,
    depth: number,
  ): Operation<{result: ToolResult; info: ToolInfo}> {
    // Root policies wrap the owner's: they check first and post-process last.
    const policies = [...new Set([root, owner])];
    let nestedCalls = 0;
    let approvals = 0;
    let info: ToolInfo = {name: call.name, details: structuredClone(call.input)};
    // Every handler publishes the request; the most specific decider answers it.
    function* publishApproval(request: ApprovalRequest): Operation<void> {
      for (const policy of policies) {
        if (policy.onApproval) yield* policy.onApproval(structuredClone(request), context.context);
      }
      if (onApproval) yield* onApproval(structuredClone(request), context.context);
    }
    const toolContext: ToolContext<C> = {
      ...context,
      callId: call.id,
      toolName: call.name,
      step: callStep,
      get info() {
        return structuredClone(info);
      },
      *describe(next) {
        if (!next || typeof next.name !== "string" || !next.name.trim())
          throw new TypeError("Tool display name must be a nonempty string");
        const snapshot: ToolInfo = {
          name: next.name,
          ...(next.details === undefined ? {} : {details: jsonSchema.parse(next.details)}),
        };
        if (JSON.stringify(snapshot).length > maxOutputChars)
          throw new AgentLimitError("Tool display information exceeds maxOutputChars");
        info = snapshot;
        yield* progress({type: "tool-info", callId: call.id, info: structuredClone(snapshot)});
      },
      *progress(value) {
        const snapshot = jsonSchema.parse(value);
        if (JSON.stringify(snapshot).length > maxOutputChars)
          throw new AgentLimitError("Tool progress exceeds maxOutputChars");
        yield* progress({type: "tool-progress", callId: call.id, value: snapshot});
      },
      availableTools: () => [...registry.registry.keys()],
      *searchTools(query) {
        const selected = yield* journal(async () => registry.search.search(query), {
          name: `tool-search:${call.id}`,
          retry: {maxAttempts: 1},
        });
        return registry.search.load(selected);
      },
      *approve(input, {question, details} = {}) {
        const request: ApprovalRequest = {
          invocationId: context.invocationId,
          call: {...call, input},
          signalName: `${context.name}:approval:${call.id}:${approvals++}`,
          ...(question === undefined ? {} : {question}),
          ...(details === undefined ? {} : {details: jsonSchema.parse(details)}),
        };
        yield* publishApproval(request);
        const decider = policies.findLast((p) => p.onHumanApproval);
        const approved = decider
          ? yield* decider.onHumanApproval!(request, toolContext)
          : yield* signal<boolean>(request.signalName);
        return approved === true;
      },
      *callTool(name, input) {
        if (registry.registry.get(name)?.handoff)
          throw new ToolError("Handoffs must be direct model calls");
        const child = {
          id: `${call.id}/nested-${nestedCalls++}`,
          name,
          input: jsonSchema.parse(input),
        };
        const result = yield* executeCall(child, callStep, owner, registry, depth + 1);
        if (result.status === "success") return result.output;
        if (result.status === "cancelled") throw new ToolCancelled(result.message);
        if (result.status === "pending")
          throw new ToolError("Unexpected pending nested call", "pending");
        throw new ToolError(
          result.message,
          result.status === "error" ? result.code : result.status,
        );
      },
      publishApproval,
      cancelOperation,
    };
    try {
      // The tool runs with the last input a policy returned; the history keeps the call.
      let input = call.input;
      for (const policy of policies) {
        if (!policy.beforeTool) continue;
        const shown = structuredClone({...call, input});
        const result = yield* checked(policy.beforeTool(shown, toolContext));
        const decision = guardrailDecision("beforeTool", result, "input", policyFailure);
        if (decision && "reject" in decision) throw new ToolDenied(decision.reject);
        if (decision) input = policyInput(decision.replace);
      }
      let output = yield* definition.execute(input, toolContext);
      for (const policy of policies.toReversed()) {
        if (policy.afterTool) output = yield* checked(policy.afterTool(output, toolContext));
      }
      output = toolOutput(output);
      if (JSON.stringify(output).length > maxOutputChars)
        throw new ToolError("Tool output exceeds maxOutputChars", "output_limit");
      return {result: {status: "success", output}, info: structuredClone(info)};
    } catch (error) {
      return {result: failedResult(error), info: structuredClone(info)};
    }
  }

  return {
    // Reject an oversized model batch before any of its effects start.
    assertCapacity(count: number) {
      if (calls + count > maxToolCalls) throw new ToolBudgetExceeded("Maximum tool calls reached");
    },
    execute(call: ToolCall, step: number, owner: AgentRuntime<C>, catalog: ToolCatalog<C>) {
      return executeCall(call, step, owner, catalog);
    },
  };
}

/** A hook result that is not a decision fails the call, as a failed check does. */
const policyFailure = (message: string) => new ToolError(message, "guardrail_failed");

/** Input a `beforeTool` policy returned. The tool validates it like the model's. */
function policyInput(value: unknown): JsonValue {
  const result = jsonSchema.safeParse(value);
  if (!result.success) throw new ToolError("beforeTool must return JSON input", "guardrail_failed");
  return result.data;
}

/** A policy that fails terminally blocks the call, and tells the model the check
 * failed rather than the tool. */
function* checked<T>(policy: Operation<T>): Operation<T> {
  try {
    return yield* policy;
  } catch (error) {
    if (terminalFailure(error))
      throw new ToolError(`Policy check failed: ${error.message}`, "guardrail_failed");
    throw error;
  }
}

function terminalFailure(error: unknown): error is TerminalError {
  return (
    error instanceof TerminalError &&
    !(error instanceof CancelledError) &&
    !(error instanceof AgentLimitError) &&
    !(error instanceof RunFailedError)
  );
}

/** Maps settled tool failures to results the model can act on. A terminal
 * failure (including exhausted retries or a failed child handler) is final for
 * the tool, not the run. Native cancellation, run budgets, and retryable errors
 * still propagate: Restate owns those. */
function failedResult(error: unknown): ToolResult {
  if (error instanceof RunInterrupted || error instanceof ToolCancelled)
    return {status: "cancelled", message: error.message};
  if (error instanceof ToolDenied) return {status: "denied", message: error.message};
  if (error instanceof ToolError)
    return {status: "error", code: error.code, message: error.message};
  if (terminalFailure(error)) return {status: "error", code: "tool_failed", message: error.message};
  throw error;
}

export type ToolExecutor<C> = ReturnType<typeof createToolExecutor<C>>;
