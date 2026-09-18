import type {Future, Operation, Task} from "@restatedev/restate-sdk-gen";
import type {z} from "zod";

/** Values that can cross a model or durable journal boundary. */
export type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};
export type ToolCall = {id: string; name: string; input: JsonValue};
export type ToolResult =
  | {status: "success"; output: JsonValue}
  | {status: "error"; code: string; message: string}
  | {status: "denied" | "cancelled"; message: string}
  | {status: "pending"; operationId: string};

/** Model context, including complete tool-call/result pairs. Caller-owned. */
export type Message =
  | {role: "user"; content: string}
  | {role: "assistant"; content: string; calls?: ToolCall[]}
  | {role: "tool"; callId: string; name: string; result: ToolResult};
export type ToolManifest = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export type ModelRequest = {
  instructions?: string;
  messages: Message[];
  tools: ToolManifest[];
  outputSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  step?: number;
};
export type ModelChunk = {type: "text-delta" | "reasoning-delta"; text: string};
export type ModelResponse =
  | {
      type: "final";
      text: string;
      output?: JsonValue;
      validationError?: string;
      chunks?: ModelChunk[];
    }
  | {type: "tool_calls"; calls: ToolCall[]; text?: string; chunks?: ModelChunk[]};
/** A local journaled call or an RPC to a model gateway are both operations. */
export type Model = (request: ModelRequest) => Operation<ModelResponse>;
export type RunContext<Context> = {
  /** Host capabilities/data; never automatically sent to the model. */
  context: Context;
  invocationId: string;
  /** Stable namespace; use distinct names for multiple runs in one handler. */
  name: string;
};
export type ApprovalRequest = {call: ToolCall; signalName: string; question?: string};
export type ToolContext<Context> = RunContext<Context> & {
  callId: string;
  toolName: string;
  availableTools(): string[];
  searchTools(query: string): Operation<{name: string; description: string}[]>;
  step: number;
  progress(value: JsonValue): Operation<void>;
  approve(input: JsonValue, question?: string): Operation<boolean>;
  /** Nested calls share validation, policy, approval, and the run's budgets. */
  callTool(name: string, input: JsonValue): Operation<JsonValue>;
  cancelOperation(id: string, reason?: string): Operation<boolean>;
};
export type GuardrailResult = void | boolean | string;
export type Tool<Context = unknown> = {
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly background?: boolean;
  readonly deferred?: boolean;
  readonly provider?: string;
  readonly search?: true;
  readonly handoff?: () => AgentRuntime<Context>;
  execute(input: JsonValue, context: ToolContext<Context>): Operation<JsonValue>;
};
export type ToolDefinition<Schema extends z.ZodType, Context> = {
  description: string;
  input: Schema;
  background?: boolean;
  deferred?: boolean;
  provider?: string;
  before?(input: z.output<Schema>, context: ToolContext<Context>): Operation<GuardrailResult>;
  needsApproval?:
    | boolean
    | ((input: z.output<Schema>, context: ToolContext<Context>) => Operation<boolean>);
  execute(input: z.output<Schema>, context: ToolContext<Context>): Operation<JsonValue>;
  after?(output: JsonValue, context: ToolContext<Context>): Operation<JsonValue>;
};
export type RunResult<Output = string> = {steps: number; messages: Message[]} & (
  | {status: "completed"; output: Output}
  | {status: "stopped"; reason: "max_steps"; output?: string}
  | {status: "interrupted"; reason: string; output?: string}
);
export type AgentEvent = {step: number} & (
  | {type: "step-start"}
  | {type: "tool-start"; call: ToolCall}
  | {type: "tool-end"; call: ToolCall; result: ToolResult}
  | {type: "tool-pending"; call: ToolCall; operationId: string}
  | {type: "approval-required"; request: ApprovalRequest}
  | {type: "progress"; callId: string; value: JsonValue}
  | {type: "steering"; message: string}
  | {type: "handoff"; from: string; to: string}
  | {type: "model-chunk"; chunk: ModelChunk}
  | {type: "output-invalid"; reason: string}
  | {type: "run-end"; status: RunResult["status"]; output?: JsonValue}
);
export type AgentUpdate = AgentEvent & {sequence: number; id: string};
export type UpdateHandler<Context> = (update: AgentUpdate, context: Context) => Operation<void>;
export type RunOptions<Context> = {
  /** Completed prior messages. The SDK copies these and returns the new history. */
  messages?: readonly Message[];
  conversation?: import("./conversation.js").Conversation;
  name?: string;
  onUpdate?: UpdateHandler<Context>;
  steeringSignal?: string;
  interruptSignal?: string;
  /** Application-supplied control futures, useful when embedding in another loop. */
  controls?: {steering?(): Future<string>; interrupt?: Future<string>};
  tools?: Record<string, Tool<Context>>;
} & (undefined extends Context ? {context?: Context} : {context: Context});
export type AgentOptions<Context, Output = string> = {
  output?: z.ZodType<Output>;
  maxOutputTokens?: number;
  name?: string;
  model: Model;
  tools?: Record<string, Tool<Context>>;
  instructions?: string | ((context: RunContext<Context>) => Operation<string>);
  /** Maximum number of planning model calls, including the final answer. Default: 10. */
  maxSteps?: number;
  maxToolCalls?: number;
  maxToolDepth?: number;
  maxOutputChars?: number;
  beforeRun?(
    messages: readonly Message[],
    context: RunContext<Context>,
  ): Operation<GuardrailResult>;
  beforeStep?(request: ModelRequest, context: RunContext<Context>): Operation<GuardrailResult>;
  beforeTool?(call: ToolCall, context: ToolContext<Context>): Operation<GuardrailResult>;
  afterTool?(output: JsonValue, context: ToolContext<Context>): Operation<JsonValue>;
  afterRun?(result: RunResult<Output>, context: RunContext<Context>): Operation<RunResult<Output>>;
  onHumanApproval?(request: ApprovalRequest, context: ToolContext<Context>): Operation<boolean>;
  onUpdate?: UpdateHandler<Context>;
  /** Optional tool-free final model call after interruption or a step limit. */
  finalize?: Model;
};
export type RunArguments<Context> = undefined extends Context
  ? [options?: RunOptions<Context>]
  : [options: RunOptions<Context>];
export type AgentStream<Output = string> = {
  next(): Operation<IteratorResult<AgentUpdate>>;
  result: Task<RunResult<Output>>;
  close(): Operation<void>;
};
export type AgentRuntime<C> = Pick<
  AgentOptions<C, unknown>,
  | "name"
  | "model"
  | "tools"
  | "instructions"
  | "beforeStep"
  | "beforeTool"
  | "afterTool"
  | "onHumanApproval"
>;
export type Agent<Context, Output = string> = {
  readonly definition: AgentRuntime<Context>;
  run(input: string, ...options: RunArguments<Context>): Operation<RunResult<Output>>;
  stream(input: string, ...options: RunArguments<Context>): Operation<AgentStream<Output>>;
};
