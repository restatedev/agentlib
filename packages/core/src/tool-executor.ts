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
  AgentEvent,
  AgentRuntime,
  RunContext,
  ToolCall,
  ToolContext,
  ToolInfo,
  ToolResult,
} from "./types.js";
import type {ToolCatalog} from "./tool-catalog.js";
import {jsonSchema} from "./validation.js";

type ToolExecutorOptions<C> = {
  root: AgentRuntime<C>;
  context: RunContext<C>;
  maxToolCalls: number;
  maxToolDepth: number;
  maxOutputChars: number;
  update: (event: AgentEvent) => Operation<void>;
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
  update,
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
    let nested = 0,
      approval = 0;
    let info: ToolInfo = {name: call.name, details: structuredClone(call.input)};
    const toolContext: ToolContext<C> = {
      ...context,
      callId: call.id,
      toolName: call.name,
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
        yield* update({type: "tool-info", step: callStep, callId: call.id, info});
      },
      step: callStep,
      availableTools: () => [...registry.registry.keys()],
      *searchTools(query) {
        const selected = yield* journal(async () => registry.search.search(query), {
          name: `tool-search:${call.id}`,
          retry: {maxAttempts: 1},
        });
        return registry.search.load(selected);
      },
      *progress(value) {
        yield* update({
          type: "progress",
          step: callStep,
          callId: call.id,
          value: jsonSchema.parse(value),
        });
      },
      *approve(input, question) {
        const request = {
          call: {...call, input},
          signalName: `${context.name}:approval:${call.id}:${approval++}`,
          ...(question === undefined ? {} : {question}),
        };
        yield* update({type: "approval-required", step: callStep, request});
        if (owner.onHumanApproval)
          return (yield* owner.onHumanApproval(request, toolContext)) === true;
        if (root.onHumanApproval)
          return (yield* root.onHumanApproval(request, toolContext)) === true;
        return (yield* signal<boolean>(request.signalName)) === true;
      },
      *callTool(name, input) {
        if (registry.registry.get(name)?.handoff)
          throw new ToolError("Handoffs must be direct model calls");
        const child = {id: `${call.id}/nested-${nested++}`, name, input: jsonSchema.parse(input)};
        yield* update({
          type: "tool-start",
          step: callStep,
          call: child,
          info: {name, details: child.input},
        });
        const result = yield* executeCall(child, callStep, owner, registry, depth + 1);
        yield* update({type: "tool-end", step: callStep, call: child, result});
        if (result.status === "success") return result.output;
        if (result.status === "cancelled") throw new ToolCancelled(result.message);
        throw new ToolError(
          "message" in result ? result.message : "Unexpected pending nested call",
          result.status === "error" ? result.code : result.status,
        );
      },
      cancelOperation,
    };
    try {
      const reason = root.beforeTool
        ? denial(yield* root.beforeTool(structuredClone(call), toolContext))
        : undefined;
      if (reason !== undefined) throw new ToolDenied(reason);
      if (owner !== root && owner.beforeTool) {
        const denied = denial(yield* owner.beforeTool(structuredClone(call), toolContext));
        if (denied !== undefined) throw new ToolDenied(denied);
      }
      let output = yield* definition.execute(call.input, toolContext);
      if (owner !== root && owner.afterTool) output = yield* owner.afterTool(output, toolContext);
      if (root.afterTool) output = yield* root.afterTool(output, toolContext);
      output = jsonSchema.parse(output);
      if (JSON.stringify(output).length > maxOutputChars)
        throw new ToolError("Tool output exceeds maxOutputChars", "output_limit");
      return {status: "success", output};
    } catch (error) {
      if (error instanceof RunInterrupted || error instanceof ToolCancelled)
        return {status: "cancelled", message: error.message};
      if (error instanceof ToolDenied) return {status: "denied", message: error.message};
      if (error instanceof ToolError)
        return {status: "error", code: error.code, message: error.message};
      throw error;
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
