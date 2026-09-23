import {run as journal, signal, type Operation} from "@restatedev/restate-sdk-gen";
import {
  AgentLimitError,
  denial,
  RunInterrupted,
  ToolCancelled,
  ToolDenied,
  ToolError,
} from "./errors.js";
import type {
  AgentRuntime,
  ApprovalHandler,
  ApprovalRequest,
  RunContext,
  ToolCall,
  ToolContext,
  ToolInfo,
  ToolResult,
} from "./types.js";
import type {ToolCatalog} from "./tool-catalog.js";
import {jsonSchema} from "./validation.js";

export type ToolExecutionLimits = Readonly<{
  maxToolCalls: number;
  maxToolDepth: number;
  maxOutputChars: number;
}>;

type ToolExecutorOptions<C> = ToolExecutionLimits & {
  root: AgentRuntime<C>;
  context: RunContext<C>;
  onApproval?: ApprovalHandler<C>;
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
    if (++calls > maxToolCalls) throw new AgentLimitError("Maximum tool calls exceeded");
    if (depth > maxToolDepth) throw new AgentLimitError("Maximum nested tool depth exceeded");
    const definition = registry.registry.get(call.name);
    if (!definition)
      return {status: "error", code: "unknown_tool", message: `Unknown tool: ${call.name}`};
    // Root policies wrap the owner's: they check first and post-process last.
    const policies = owner === root ? [root] : [root, owner];
    let nestedCalls = 0;
    let approvals = 0;
    let info: ToolInfo = {name: call.name, details: structuredClone(call.input)};
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
      },
      availableTools: () => [...registry.registry.keys()],
      *searchTools(query) {
        const selected = yield* journal(async () => registry.search.search(query), {
          name: `tool-search:${call.id}`,
          retry: {maxAttempts: 1},
        });
        return registry.search.load(selected);
      },
      *approve(input, question) {
        const request: ApprovalRequest = {
          invocationId: context.invocationId,
          call: {...call, input},
          signalName: `${context.name}:approval:${call.id}:${approvals++}`,
          ...(question === undefined ? {} : {question}),
        };
        // Every handler publishes the request; the most specific decider answers it.
        for (const publish of [...policies.map((p) => p.onApproval), onApproval]) {
          if (publish) yield* publish(structuredClone(request), context.context);
        }
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
      cancelOperation,
    };
    try {
      for (const policy of policies) {
        if (!policy.beforeTool) continue;
        const reason = denial(yield* policy.beforeTool(structuredClone(call), toolContext));
        if (reason !== undefined) throw new ToolDenied(reason);
      }
      let output = yield* definition.execute(call.input, toolContext);
      for (const policy of policies.toReversed()) {
        if (policy.afterTool) output = yield* policy.afterTool(output, toolContext);
      }
      output = jsonSchema.parse(output);
      if (JSON.stringify(output).length > maxOutputChars)
        throw new ToolError("Tool output exceeds maxOutputChars", "output_limit");
      return {status: "success", output};
    } catch (error) {
      return failedResult(error);
    }
  }

  return {
    // Reject an oversized model batch before any of its effects start.
    assertCapacity(count: number) {
      if (calls + count > maxToolCalls) throw new AgentLimitError("Maximum tool calls exceeded");
    },
    execute(call: ToolCall, step: number, owner: AgentRuntime<C>, catalog: ToolCatalog<C>) {
      return executeCall(call, step, owner, catalog);
    },
  };
}

/** Maps model-recoverable failures to results; anything else fails the run. */
function failedResult(error: unknown): ToolResult {
  if (error instanceof RunInterrupted || error instanceof ToolCancelled)
    return {status: "cancelled", message: error.message};
  if (error instanceof ToolDenied) return {status: "denied", message: error.message};
  if (error instanceof ToolError)
    return {status: "error", code: error.code, message: error.message};
  throw error;
}

export type ToolExecutor<C> = ReturnType<typeof createToolExecutor<C>>;
