import type {
  Context as RestateContext,
  InvocationPromise,
  RestatePromise,
} from "@restatedev/restate-sdk";
import type {
  AgentOptions as CoreAgentOptions,
  AgentUpdate,
  ApprovalRequest,
  AsyncToolDefinition as CoreAsyncToolDefinition,
  GuardrailResult,
  JsonValue,
  Message,
  RunResult,
  Tool as CoreTool,
  ToolContext as CoreToolContext,
  ToolDefinition as CoroutineToolDefinition,
} from "@restate-agents/core";
import type {z} from "zod";

export type Agent<Context = undefined, Output = string> = {
  run(
    ctx: RestateContext,
    input: string,
    ...options: RunArguments<Context>
  ): Promise<RunResult<Output>>;
};

/** Shared model adapters and limits, with tools for the regular SDK. */
export type AgentOptions<Context = undefined, Output = string> = Pick<
  CoreAgentOptions<Context, Output>,
  | "name"
  | "model"
  | "output"
  | "finalize"
  | "maxSteps"
  | "maxToolCalls"
  | "maxToolDepth"
  | "maxOutputTokens"
  | "maxOutputChars"
> & {
  instructions?: string;
  tools?: Record<string, Tool<Context>>;
  onUpdate?: UpdateHandler<Context>;
  onApproval?: ApprovalHandler<Context>;
};

/** Observe updates synchronously or return a durable SDK promise; do not use async. */
export type UpdateHandler<Context = unknown> = (
  update: AgentUpdate,
  ctx: RestateContext,
  context: Context,
) => void | RestatePromise<void>;

/** Publish synchronously or return durable SDK work before waiting for the decision. */
export type ApprovalHandler<Context = unknown> = (
  request: ApprovalRequest,
  ctx: RestateContext,
  context: Context,
) => void | RestatePromise<void>;

export type RunOptions<Context = undefined> = {
  messages?: readonly Message[];
  name?: string;
  steeringSignal?: string;
  interruptSignal?: string;
  tools?: Record<string, Tool<Context>>;
  onUpdate?: UpdateHandler<Context>;
  onApproval?: ApprovalHandler<Context>;
} & (undefined extends Context ? {context?: Context} : {context: Context});

export type RunArguments<Context> = undefined extends Context
  ? [options?: RunOptions<Context>]
  : [options: RunOptions<Context>];

/** Tool metadata and application data, without coroutine-only operations. */
export type ToolContext<Context = unknown> = Pick<
  CoreToolContext<Context>,
  "context" | "invocationId" | "name" | "callId" | "toolName" | "step" | "info" | "availableTools"
>;

declare const toolContext: unique symbol;

/** An opaque tool handle. The promise entry point owns conversion to core tools. */
export type Tool<Context = unknown> = Pick<
  CoreTool<Context>,
  "description" | "inputSchema" | "background" | "deferred" | "provider"
> & {
  readonly [toolContext]: (context: Context) => void;
};

/** Hooks may return a synchronous value or a durable SDK promise. */
export type ToolHook<Input, Output, Context> = (
  input: Input,
  ctx: RestateContext,
  context: ToolContext<Context>,
) => Output | RestatePromise<Output>;

export type ToolOptions<Schema extends z.ZodType, Context> = Pick<
  CoroutineToolDefinition<Schema, Context>,
  "description" | "input" | "describe" | "background" | "deferred" | "provider"
> & {
  before?: ToolHook<z.output<Schema>, GuardrailResult, Context>;
  needsApproval?: boolean | ToolHook<z.output<Schema>, boolean, Context>;
  after?: ToolHook<JsonValue, JsonValue, Context>;
};

/** Return the SDK promise directly; async callbacks produce native promises. */
export type ToolDefinition<Schema extends z.ZodType, Context = unknown> = ToolOptions<
  Schema,
  Context
> & {
  execute(
    input: z.output<Schema>,
    ctx: RestateContext,
    context: ToolContext<Context>,
  ): RestatePromise<JsonValue>;
};

/** Ordinary async I/O; execution is journaled by core, outside the SDK context. */
export type AsyncToolDefinition<Schema extends z.ZodType, Context = unknown> = ToolOptions<
  Schema,
  Context
> &
  Pick<CoreAsyncToolDefinition<Schema, Context>, "execute" | "retry">;

/** Typed SDK calls retain their invocation handle for cancellation. */
export type HandlerToolDefinition<Schema extends z.ZodType, Context = unknown> = ToolOptions<
  Schema,
  Context
> & {
  call(
    input: z.output<Schema>,
    ctx: RestateContext,
    context: ToolContext<Context>,
  ): InvocationPromise<JsonValue>;
};
