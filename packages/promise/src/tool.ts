import {isRestatePromise, type InvocationPromise} from "@restatedev/restate-sdk";
import {
  gen,
  invocation,
  spawn,
  type ClientFuture,
  type Operation,
} from "@restatedev/restate-sdk-gen";
import {
  adopt,
  asyncTool as coreAsyncTool,
  tool as coroutineTool,
  handlerTool as coroutineHandlerTool,
  type Tool as CoreTool,
  type ToolContext as CoreToolContext,
  type ToolDefinition as CoreToolDefinition,
} from "@restate-agents/core";
import type {z} from "zod";
import {currentContext} from "./context.js";
import {resolveHook} from "./hooks.js";
import type {
  AsyncToolDefinition,
  HandlerToolDefinition,
  Tool,
  ToolContext,
  ToolDefinition,
  ToolHook,
  ToolOptions,
} from "./types.js";

type CoreToolOptions<S extends z.ZodType, C> = Omit<CoreToolDefinition<S, C>, "execute">;
type CoreToolHook<Input, Output, C> = (
  input: Input,
  context: CoreToolContext<C>,
) => Operation<Output>;

/** Adapt a tool returning a RestatePromise into the agent's existing tool lifecycle. */
export function tool<S extends z.ZodType, C = unknown>(definition: ToolDefinition<S, C>): Tool<C> {
  const core = coroutineTool({
    ...toCoreOptions(definition),
    *execute(input, context) {
      return yield* adopt(definition.execute(input, currentContext(), toolContext(context)));
    },
  });
  return core as unknown as Tool<C>;
}

/** Journal ordinary async I/O with the same policies and error handling as core. */
export function asyncTool<S extends z.ZodType, C = unknown>(
  definition: AsyncToolDefinition<S, C>,
): Tool<C> {
  const core = coreAsyncTool({
    ...toCoreOptions(definition),
    execute: definition.execute,
    retry: definition.retry,
  });
  return core as unknown as Tool<C>;
}

/** Use a regular SDK typed client; unfinished calls are cancelled on interruption. */
export function handlerTool<S extends z.ZodType, C = unknown>(
  definition: HandlerToolDefinition<S, C>,
): Tool<C> {
  const core = coroutineHandlerTool({
    ...toCoreOptions(definition),
    call(input, context) {
      return adoptInvocation(definition.call(input, currentContext(), toolContext(context)));
    },
  });
  return core as unknown as Tool<C>;
}

// Handles are core tools internally; their public type hides coroutine execution.
export function toCoreTools<C>(
  tools?: Record<string, Tool<C>>,
): Record<string, CoreTool<C>> | undefined {
  return tools as unknown as Record<string, CoreTool<C>> | undefined;
}

function toolContext<C>(context: CoreToolContext<C>): ToolContext<C> {
  return {
    context: context.context,
    invocationId: context.invocationId,
    name: context.name,
    callId: context.callId,
    toolName: context.toolName,
    step: context.step,
    get info() {
      return context.info;
    },
    availableTools: () => context.availableTools(),
  };
}

function toCoreOptions<S extends z.ZodType, C>(options: ToolOptions<S, C>): CoreToolOptions<S, C> {
  const {before, after, needsApproval, ...metadata} = options;
  let approval: CoreToolOptions<S, C>["needsApproval"];
  if (typeof needsApproval === "function") {
    approval = toCoreHook(needsApproval);
  } else {
    approval = needsApproval;
  }
  return {
    ...metadata,
    before: toCoreHook(before),
    after: toCoreHook(after),
    needsApproval: approval,
  };
}

function toCoreHook<Input, Output, C>(
  hook?: ToolHook<Input, Output, C>,
): CoreToolHook<Input, Output, C> | undefined {
  if (!hook) return undefined;
  return function* (input, context) {
    return yield* resolveHook(hook(input, currentContext(), toolContext(context)));
  };
}

export function adoptInvocation<T>(promise: InvocationPromise<T>): ClientFuture<T> {
  const future = adopt(promise);
  // The regular SDK types invocationId as Promise, but returns a RestatePromise.
  const invocationId = promise.invocationId;
  if (!isRestatePromise(invocationId)) {
    throw new TypeError("handlerTool requires an invocation handle from a regular SDK client.");
  }
  const reference = spawn(
    gen(function* () {
      return invocation<T>(yield* adopt(invocationId));
    }),
  );
  return Object.assign(future, {invocation: reference});
}
