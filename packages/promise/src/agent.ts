import {
  agent as coroutineAgent,
  type Agent as CoreAgent,
  type ApprovalHandler as CoreApprovalHandler,
  type RunOptions as CoreRunOptions,
} from "@restate-agents/core";
import {execute, gen} from "@restatedev/restate-sdk-gen";
import {currentContext, restateContext} from "./context.js";
import {resolveHook} from "./hooks.js";
import {toCoreTools} from "./tool.js";
import type {Agent, AgentOptions, ApprovalHandler, RunOptions} from "./types.js";

/** Run an agent from a regular SDK handler. Each call owns its coroutine scheduler. */
export function agent<C = undefined, O = string>(options: AgentOptions<C, O>): Agent<C, O> {
  const inner = coroutineAgent({
    ...options,
    tools: toCoreTools(options.tools),
    onApproval: toCoreApprovalHandler(options.onApproval),
  });
  return {
    run(ctx, input, ...options) {
      // The public signature enforces required application context before adapting
      // the conditional options tuple to the core's corresponding signature.
      const args = [input, toCoreRunOptions(options[0])] as unknown as Parameters<
        CoreAgent<C, O>["run"]
      >;
      return execute(
        ctx,
        gen(function* () {
          restateContext.set(ctx);
          return yield* inner.run(...args);
        }),
      );
    },
  };
}

function toCoreRunOptions<C>(options?: RunOptions<C>): CoreRunOptions<C> | undefined {
  if (!options) return undefined;
  return {
    ...options,
    tools: toCoreTools(options.tools),
    onApproval: toCoreApprovalHandler(options.onApproval),
  };
}

function toCoreApprovalHandler<C>(hook?: ApprovalHandler<C>): CoreApprovalHandler<C> | undefined {
  if (!hook) return undefined;
  return function* (request, context) {
    yield* resolveHook(hook(request, currentContext(), context));
  };
}
