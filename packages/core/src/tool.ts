import {CancelledError} from "@restatedev/restate-sdk";
import {
  InterruptedError,
  run,
  type ClientFuture,
  type Operation,
  type RetryOptions,
} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {denial, ToolDenied, ToolError} from "./errors.js";
import type {AgentRuntime, JsonValue, Tool, ToolContext, ToolDefinition} from "./types.js";
import {jsonSchema} from "./validation.js";

/** Describe a tool; its generator composes directly with Restate operations. */
export function tool<Schema extends z.ZodType, Context = unknown>(
  definition: ToolDefinition<Schema, Context>,
): Tool<Context> {
  return {
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.input, {io: "input"}),
    background: definition.background,
    deferred: definition.deferred,
    provider: definition.provider,
    *execute(input, context): Operation<JsonValue> {
      const parsed = definition.input.safeParse(input);
      if (!parsed.success)
        throw new ToolError(`Invalid tool input: ${parsed.error.message}`, "invalid_input");
      if (definition.describe)
        yield* context.describe(
          typeof definition.describe === "function"
            ? definition.describe(structuredClone(parsed.data))
            : definition.describe,
        );
      const reason = definition.before
        ? denial(yield* definition.before(parsed.data, context))
        : undefined;
      if (reason !== undefined) throw new ToolDenied(reason);
      const approval =
        typeof definition.needsApproval === "function"
          ? yield* definition.needsApproval(parsed.data, context)
          : definition.needsApproval;
      if (approval && !(yield* context.approve(jsonSchema.parse(parsed.data))))
        throw new ToolDenied("Human approval denied");
      let result = yield* definition.execute(parsed.data, context);
      if (definition.after) result = yield* definition.after(result, context);
      return jsonSchema.parse(result);
    },
  };
}

type AsyncContext<C> = Pick<
  ToolContext<C>,
  "context" | "invocationId" | "name" | "callId" | "step"
> & {signal: AbortSignal};
/** Explicit durability boundary for ordinary I/O; preserves business errors on replay. */
export function asyncTool<S extends z.ZodType, C = unknown>(
  definition: Omit<ToolDefinition<S, C>, "execute"> & {
    execute(input: z.output<S>, context: AsyncContext<C>): Promise<JsonValue>;
    retry?: RetryOptions;
  },
): Tool<C> {
  return tool({
    ...definition,
    *execute(input, context) {
      const result = yield* run(
        async ({signal}) => {
          try {
            const {invocationId, name, callId, step} = context;
            return {
              ok: true as const,
              value: jsonSchema.parse(
                await definition.execute(input, {
                  context: context.context,
                  invocationId,
                  name,
                  callId,
                  step,
                  signal,
                }),
              ),
            };
          } catch (error) {
            if (error instanceof ToolError)
              return {ok: false as const, message: error.message, code: error.code};
            throw error;
          }
        },
        {name: context.info.name, retry: definition.retry ?? {maxAttempts: 1}},
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

/** Transfer this task after the current batch settles, preserving its history. */
export function handoff<C>(
  target: {readonly definition: AgentRuntime<C>} | (() => {readonly definition: AgentRuntime<C>}),
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
