import {CancelledError} from "@restatedev/restate-sdk";
import {
  InterruptedError,
  run,
  type ClientFuture,
  type Operation,
} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {denial, ToolCancelled, ToolDenied, ToolError} from "./errors.js";
import type {
  Agent,
  AsyncToolDefinition,
  GuardrailResult,
  JsonValue,
  RunOptions,
  RunResult,
  Tool,
  ToolContext,
  ToolDefinition,
  ToolInfo,
} from "./types.js";
import {jsonSchema, toolOutput} from "./validation.js";

/** Outcome of parsing raw tool input into the definition's validated shape. */
export type ParseResult<T> = {ok: true; data: T} | {ok: false; error: string};

/**
 * The tool lifecycle callbacks (describe/before/approval/execute/after). Kept as one
 * object so {@link buildTool} invokes them as methods (preserving `this`), and so a
 * caller can pass a whole definition through as its lifecycle.
 */
export type ToolLifecycle<Data, Context> = {
  describe?: ToolInfo | ((input: Data) => ToolInfo);
  before?(input: Data, context: ToolContext<Context>): Operation<GuardrailResult>;
  needsApproval?: boolean | ((input: Data, context: ToolContext<Context>) => Operation<boolean>);
  execute(input: Data, context: ToolContext<Context>): Operation<JsonValue>;
  after?(output: JsonValue, context: ToolContext<Context>): Operation<JsonValue>;
};

/**
 * Everything {@link buildTool} needs to assemble a tool, decoupled from any particular
 * input-schema source: the JSON Schema is supplied directly and raw input is turned into
 * validated `Data` by `parseInput`, so tools can be built from zod ({@link tool}) or from
 * a ready-made JSON Schema (see `service-tool.ts`) sharing one lifecycle implementation.
 */
export type BuildToolSpec<Data, Context> = {
  description: string;
  inputSchema: Record<string, unknown>;
  parseInput(raw: JsonValue): ParseResult<Data>;
  background?: boolean;
  deferred?: boolean;
  provider?: string;
  lifecycle: ToolLifecycle<Data, Context>;
};

/** Assemble a tool from an explicit JSON Schema and a pluggable input parser. */
export function buildTool<Data, Context = unknown>(
  spec: BuildToolSpec<Data, Context>,
): Tool<Context> {
  const {lifecycle} = spec;
  return {
    description: spec.description,
    inputSchema: spec.inputSchema,
    background: spec.background,
    deferred: spec.deferred,
    provider: spec.provider,
    // A static label is known before the call runs, so it can name the start too.
    ...(lifecycle.describe && typeof lifecycle.describe !== "function"
      ? {info: lifecycle.describe}
      : {}),
    *execute(input, context): Operation<JsonValue> {
      const parsed = spec.parseInput(input);
      if (!parsed.ok) throw new ToolError(`Invalid tool input: ${parsed.error}`, "invalid_input");
      const data = parsed.data;
      if (lifecycle.describe) {
        const info =
          typeof lifecycle.describe === "function"
            ? lifecycle.describe(structuredClone(data as JsonValue) as Data)
            : lifecycle.describe;
        yield* context.describe(info);
      }
      if (lifecycle.before) {
        const reason = denial(yield* lifecycle.before(data, context));
        if (reason !== undefined) throw new ToolDenied(reason);
      }
      const approval =
        typeof lifecycle.needsApproval === "function"
          ? yield* lifecycle.needsApproval(data, context)
          : lifecycle.needsApproval;
      if (approval && !(yield* context.approve(jsonSchema.parse(data as JsonValue))))
        throw new ToolDenied("Human approval denied");
      let result = yield* lifecycle.execute(data, context);
      if (lifecycle.after) result = yield* lifecycle.after(result, context);
      return toolOutput(result);
    },
  };
}

/** Describe a tool; its generator composes directly with Restate operations. */
export function tool<Schema extends z.ZodType, Context = unknown>(
  definition: ToolDefinition<Schema, Context>,
): Tool<Context> {
  return buildTool<z.output<Schema>, Context>({
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.input, {io: "input"}),
    parseInput(raw) {
      const parsed = definition.input.safeParse(raw);
      return parsed.success
        ? {ok: true, data: parsed.data}
        : {ok: false, error: parsed.error.message};
    },
    background: definition.background,
    deferred: definition.deferred,
    provider: definition.provider,
    // The definition itself is the lifecycle; methods stay bound to it.
    lifecycle: definition,
  });
}

/** Explicit durability boundary for ordinary I/O; preserves business errors on replay. */
export function asyncTool<S extends z.ZodType, C = unknown>(
  definition: AsyncToolDefinition<S, C>,
): Tool<C> {
  return tool({
    ...definition,
    *execute(input, context) {
      const result = yield* run(
        async ({signal}) => {
          try {
            const {invocationId, name, callId, step} = context;
            const output = await definition.execute(input, {
              context: context.context,
              invocationId,
              name,
              callId,
              step,
              signal,
            });
            return {ok: true as const, value: toolOutput(output)};
          } catch (error) {
            if (error instanceof ToolError)
              return {ok: false as const, message: error.message, code: error.code};
            throw error;
          }
        },
        {name: context.info.name, retry: definition.retry ?? {maxAttempts: 3}},
      );
      if (!result.ok) throw new ToolError(result.message, result.code);
      return result.value;
    },
  });
}

/** Await a Restate child and cancel it if this operation is interrupted. */
export function* awaitChild<T>(future: ClientFuture<T>): Operation<T> {
  // Keep acquisition inside the cancellation boundary. If interrupted before the
  // invocation ID arrives, join that future during cleanup before cancelling it.
  try {
    return yield* future;
  } catch (error) {
    if (error instanceof InterruptedError || error instanceof CancelledError) {
      const invocation = yield* future.invocation;
      invocation.cancel();
    }
    throw error;
  }
}

/** Call a Restate handler through a typed client; interruption cancels the child. */
export function handlerTool<S extends z.ZodType, C = unknown>(
  definition: Omit<ToolDefinition<S, C>, "execute"> & {
    call(input: z.output<S>, context: ToolContext<C>): ClientFuture<JsonValue>;
  },
): Tool<C> {
  return tool({
    ...definition,
    *execute(input, context) {
      return yield* awaitChild(definition.call(input, context));
    },
  });
}

type HandoffAgent<C> = Pick<Agent<C>, "definition">;

/** Transfer this task after the current batch settles, preserving its history. */
export function handoff<C>(
  target: HandoffAgent<C> | (() => HandoffAgent<C>),
  description = "Transfer this task to the specialist.",
): Tool<C> {
  return {
    ...tool({
      description,
      input: z.object({}),
      *execute() {
        return {transferred: true};
      },
    }),
    handoff: () => (typeof target === "function" ? target() : target).definition,
  };
}

export type AgentToolOptions = {
  /** What the sub-agent is for; the model reads this to decide when to delegate. */
  description: string;
  /** Let the parent keep working while the sub-agent runs. */
  background?: boolean;
  deferred?: boolean;
  needsApproval?: boolean;
};

const delegatedTask = z.object({
  task: z.string().min(1).describe("A complete, self-contained description of the task."),
});

/** Delegate a task to another agent as one tool call. The sub-agent runs in this
 * invocation with a fresh conversation, its own limits, and the parent's context,
 * and its answer (text or structured output) becomes the tool result. Every step
 * is journaled, and interrupting the parent interrupts the sub-agent. */
export function agentTool<C, O>(
  subAgent: Pick<Agent<C, O>, "run">,
  options: AgentToolOptions,
): Tool<C> {
  return tool({
    ...options,
    input: delegatedTask,
    *execute({task}, context) {
      const runOptions = {
        context: context.context,
        // A run name unique to this call keeps approval signals of concurrent sub-agents apart.
        name: `${context.name}/${context.callId}`,
        // The sub-agent's approval requests reach whoever the parent run publishes to.
        onApproval: context.publishApproval,
        // Each sub-agent event arrives as progress of the parent's call.
        onProgress: (event) => context.progress(event),
      } as RunOptions<C>;
      const run = subAgent.run as (
        input: string,
        options: RunOptions<C>,
      ) => Operation<RunResult<O>>;
      const result = yield* run.call(subAgent, task, runOptions);
      if (result.status === "completed") return jsonSchema.parse(result.output);
      if (result.status === "interrupted") throw new ToolCancelled(result.reason);
      throw new ToolError(
        result.output ?? `The sub-agent stopped before finishing: ${result.reason}`,
        "agent_stopped",
      );
    },
  });
}
