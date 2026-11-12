import type {Future, Operation, RetryOptions} from "@restatedev/restate-sdk-gen";
import type {z} from "zod";

/** Values that can cross a model or durable journal boundary. */
export type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};
export type ToolCall = {
  id: string;
  name: string;
  input: JsonValue;
  /** Model arguments could not be parsed or validated. Return a tool error without execution. */
  validationError?: string;
};
/** Display-only information. It is never included in a model's tool schema or history. */
export type ToolInfo = {name: string; details?: JsonValue};
export type ToolResult =
  | {status: "success"; output: JsonValue}
  | {status: "error"; code: string; message: string}
  | {status: "denied" | "cancelled"; message: string}
  | {status: "pending"; operationId: string};

/** A model's reasoning with a response, kept exactly as its provider returned it: Claude's
 * signed thinking or OpenAI's encrypted reasoning `items`, and in `calls` each tool call's
 * metadata by call id, such as Gemini's thought signatures. `text` keeps text-part
 * original text and signature metadata together. It goes back with the response
 * on later requests, so the model builds on its reasoning instead of redoing it. Never
 * edit it: providers reject reasoning that changed. `tokens` is what it takes in the
 * model's context, as the provider reported it. */
export type Reasoning = {
  items: JsonValue[];
  calls?: {[callId: string]: JsonValue};
  text?: {text: string; providerOptions?: {[provider: string]: JsonValue}}[];
  tokens?: number;
};

/** Model context, including complete tool-call/result pairs. Caller-owned. */
export type Message =
  | {role: "user"; content: string}
  | {role: "assistant"; content: string; calls?: ToolCall[]; reasoning?: Reasoning}
  | {role: "tool"; callId: string; name: string; result: ToolResult};
export type ToolManifest = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export type ModelRequest = {
  instructions?: string;
  /** The run's recorded messages, shared with its history: read them, never change them. */
  messages: Message[];
  tools: ToolManifest[];
  outputSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  step?: number;
};
export type ModelChunk = {type: "text-delta" | "reasoning-delta"; text: string};
/** Tokens a model call used, as the provider reported them. `inputTokens`
 * includes the cached input read (`cachedInputTokens`) and written
 * (`cacheWriteInputTokens`); providers that cache on their own report no writes. */
export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
};
export type ModelFinalResponse = {
  type: "final";
  text: string;
  output?: JsonValue;
  validationError?: string;
  usage?: ModelUsage;
  reasoning?: Reasoning;
};
export type ModelToolCallsResponse = {
  type: "tool_calls";
  calls: ToolCall[];
  text?: string;
  usage?: ModelUsage;
  reasoning?: Reasoning;
};
export type ModelResponse = ModelFinalResponse | ModelToolCallsResponse;
/** A local journaled call or an RPC to a model gateway are both operations. */
export type Model = (request: ModelRequest) => Operation<ModelResponse>;
export type RunContext<Context> = {
  /** Host capabilities/data; never automatically sent to the model. */
  context: Context;
  invocationId: string;
  /** Stable namespace; use distinct names for multiple runs in one handler. */
  name: string;
};
export type ApprovalRequest = {
  invocationId: string;
  call: ToolCall;
  signalName: string;
  question?: string;
  /** Application data for the approval handlers, such as the policy that asked. */
  details?: JsonValue;
};
export type ApproveOptions = {question?: string; details?: JsonValue};
/** Publish an approval request before the SDK waits for its decision. */
export type ApprovalHandler<Context = unknown> = (
  request: ApprovalRequest,
  context: Context,
) => Operation<void>;
/** What a run is doing, in journal order. Replay delivers the same sequence again. */
export type ProgressEvent =
  | {type: "step"; step: number}
  /** `info` is the tool's static display information, when it declares one. */
  | {type: "tool-start"; callId: string; name: string; input: JsonValue; info?: ToolInfo}
  | {type: "tool-info"; callId: string; info: ToolInfo}
  | {type: "tool-progress"; callId: string; value: JsonValue}
  /** `info` is the call's final display information, as set by `describe`. */
  | {type: "tool-end"; callId: string; name: string; result: ToolResult; info: ToolInfo}
  | {type: "steering"; message: string; data?: JsonValue}
  | {type: "handoff"; agent?: string}
  /** The run replaced older messages of the model's view, with a handoff note
   * (`summary`) or a short runtime note (`truncate`), or failed to summarize.
   * `threshold` means past `compaction.maxTokens`, `window` that the next
   * request would not fit `contextWindow`, and `overflow` that the model had
   * rejected the view as too long. */
  | {
      type: "compaction";
      mode: "summary" | "truncate";
      status: "applied" | "failed";
      reason: "threshold" | "window" | "overflow";
      error?: string;
    };
/** Receives each event before the run continues. Spawn work that should not block it. */
export type ProgressHandler<Context = unknown> = (
  event: ProgressEvent,
  context: Context,
) => Operation<void>;
export type ToolContext<Context> = RunContext<Context> & {
  callId: string;
  toolName: string;
  /** Current display information; each read returns an isolated snapshot. */
  readonly info: ToolInfo;
  /** Publish display information without modifying this call's input or identity. */
  describe(info: ToolInfo): Operation<void>;
  /** Report partial progress to the run's onProgress handler. */
  progress(value: JsonValue): Operation<void>;
  availableTools(): string[];
  searchTools(query: string): Operation<{name: string; description: string}[]>;
  step: number;
  approve(input: JsonValue, options?: ApproveOptions): Operation<boolean>;
  /** Publish an approval request through this run's handlers without waiting for it,
   * e.g. one raised inside a sub-agent. */
  readonly publishApproval: (request: ApprovalRequest) => Operation<void>;
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
  /** Static display information, from a `describe` that does not depend on input. */
  readonly info?: ToolInfo;
  readonly search?: true;
  /** A program runs other tools and may wait for minutes. When steering arrives,
   * the run moves it to background work instead of waiting for it. */
  readonly program?: true;
  readonly handoff?: () => AgentRuntime<Context>;
  execute(input: JsonValue, context: ToolContext<Context>): Operation<JsonValue>;
};
export type ToolDefinition<Schema extends z.ZodType, Context> = {
  description: string;
  input: Schema;
  /** Optional display override; defaults to the registered tool name and call arguments.
   * Accepts static information or a pure projection of a copy of validated input. */
  describe?: ToolInfo | ((input: z.output<Schema>) => ToolInfo);
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
/** Data and cancellation for ordinary I/O inside a journaled tool execution. */
export type AsyncToolContext<Context = unknown> = Pick<
  ToolContext<Context>,
  "context" | "invocationId" | "name" | "callId" | "step"
> & {signal: AbortSignal};
export type AsyncToolDefinition<Schema extends z.ZodType, Context = unknown> = Omit<
  ToolDefinition<Schema, Context>,
  "execute"
> & {
  execute(input: z.output<Schema>, context: AsyncToolContext<Context>): Promise<JsonValue>;
  /** Defaults to three attempts. Use `callId` as an idempotency key for external writes. */
  retry?: RetryOptions;
};
export type RunResult<Output = string> = {steps: number; messages: Message[]} & (
  | {status: "completed"; output: Output}
  | {status: "stopped"; reason: "max_steps" | "max_tool_calls"; output?: string}
  | {status: "interrupted"; reason: string; output?: string}
);
// Keep recursive JSON arrays behind an array interface so diagnostics terminate.
// Tuples retain their positions, including optional and variadic elements.
type ReadonlyValue<T> = T extends readonly unknown[]
  ? "0" extends keyof T
    ? {readonly [Key in keyof T]: ReadonlyValue<T[Key]>}
    : T extends readonly []
      ? readonly []
      : ReadonlyArray<ReadonlyValue<T[number]>>
  : T extends object
    ? {readonly [Key in keyof T]: ReadonlyValue<T[Key]>}
    : T;

/** Isolated facts and candidate output for a policy to inspect, before publication. */
export type OutputCandidate<Output = string> = ReadonlyValue<RunResult<Output>>;

/** Replace output only. Stopped/interrupted runs accept an optional text summary. */
export type OutputDecision<Output = string> = {
  output: ReadonlyValue<Output> | string | undefined;
  status?: never;
  steps?: never;
  reason?: never;
  messages?: never;
};
/** A steering message, with application data returned on its progress event. */
export type SteeringUpdate = {message: string; data?: JsonValue};
export type SteeringSource = () => Future<string | SteeringUpdate>;
export type RunControls = {steering?: SteeringSource; interrupt?: Future<string>};
export type RunOptions<Context> = {
  /** Completed prior messages. The SDK copies these and returns the new history. */
  messages?: readonly Message[];
  conversation?: import("./conversation.js").Conversation;
  name?: string;
  onApproval?: ApprovalHandler<Context>;
  onProgress?: ProgressHandler<Context>;
  steeringSignal?: string;
  interruptSignal?: string;
  /** Application-supplied control futures, useful when embedding in another loop. */
  controls?: RunControls;
  tools?: Record<string, Tool<Context>>;
} & (undefined extends Context ? {context?: Context} : {context: Context});
export type AgentOptions<Context, Output = string> = {
  /** JSON-Schema-representable output validation; transforms are not supported. */
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
  /** Return nothing to accept, {output} to replace, or throw to reject. */
  afterRun?(
    candidate: OutputCandidate<Output>,
    context: RunContext<Context>,
  ): Operation<void | OutputDecision<Output>>;
  onApproval?: ApprovalHandler<Context>;
  /** Override the decision mechanism; onApproval only publishes the request. */
  onHumanApproval?(request: ApprovalRequest, context: ToolContext<Context>): Operation<boolean>;
  /** Tool-free model call that summarizes an interrupted or step-limited run. Default: model; false skips it. */
  finalize?: Model | false;
  /** Summarizes this run's older messages when the model's view outgrows
   * `maxTokens` (default 100000). The size is the input tokens the model last
   * reported plus an estimate for messages added since, or an estimate of the
   * messages, instructions and tools before any report. The newest messages
   * that fit `retainTokens` (default a quarter of maxTokens, and at most half
   * of what instructions and tools leave) stay verbatim. The saved
   * and returned transcript is unchanged. `model` defaults to the agent's. */
  compaction?: {model?: Model; maxTokens?: number; retainTokens?: number};
  /** The model's context window in tokens. Before each model call, a view that
   * would not fit with `maxOutputTokens` is shrunk first: summarized when
   * `compaction` is set, truncated otherwise, to `compaction.retainTokens` or
   * a quarter of the window, whichever is smaller. Without it, only an
   * overflow error the model reports as such (a `ContextOverflowError`) is
   * recovered from; some providers give an overflow no distinct code. */
  contextWindow?: number;
  /** Shows the model a preview of each tool result estimated above `maxTokens`
   * (default 5000): its head and tail, `previewTokens` in all (default 2500).
   * The model reads the rest with the `read_tool_result` tool, listed in every
   * request so the tool list, and with it the cached prefix, stays the same
   * all run; an agent without other tools lists it only for previews in its
   * loaded history. The saved and returned transcript keeps every result whole.
   * `false` shows every result in full. */
  toolResults?: false | {maxTokens?: number; previewTokens?: number};
  /** Skills the model can load when a task needs them. The run lists them once
   * at its start, after the instructions, and adds `load_skill` (and
   * `read_skill_file` when the source can read files). They belong to the
   * run, so they survive a handoff. */
  skills?: SkillSource;
};
/** A skill as the model first sees it: picked by its description, loaded by name. */
export type SkillSummary = {
  name: string;
  description: string;
  /** Where the source finds the skill, such as a folder or a URL pinned to a
   * commit. It is journaled with the list, so every load and read of a run
   * sees the same location, also after a replay. Never shown to the model. */
  location?: string;
};
/**
 * Where an agent's skills come from: files, a repository, state, or code.
 * Each call runs journaled, like an `asyncTool`, so a source can do plain I/O
 * and a replay reads the journal instead of calling it again.
 */
export type SkillSource = {
  /** The skills to offer. Called once per run; the list holds for the run. */
  list(options: {signal: AbortSignal}): Promise<SkillSummary[]>;
  /** A skill's instructions, such as the body of its SKILL.md. */
  load(skill: SkillSummary, options: {signal: AbortSignal}): Promise<string>;
  /** A file a skill's instructions refer to, by a path relative to the skill. */
  read?(skill: SkillSummary, path: string, options: {signal: AbortSignal}): Promise<string>;
  /** Retries for each call. Default: three attempts. */
  retry?: RetryOptions;
};
export type RunArguments<Context> = undefined extends Context
  ? [options?: RunOptions<Context>]
  : [options: RunOptions<Context>];
export type AgentRuntime<C> = Pick<
  AgentOptions<C, unknown>,
  | "name"
  | "model"
  | "tools"
  | "instructions"
  | "beforeStep"
  | "beforeTool"
  | "afterTool"
  | "onApproval"
  | "onHumanApproval"
>;
export type Agent<Context, Output = string> = {
  readonly definition: AgentRuntime<Context>;
  run(input: string, ...options: RunArguments<Context>): Operation<RunResult<Output>>;
};
