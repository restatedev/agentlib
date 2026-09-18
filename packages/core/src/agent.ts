import {z} from "zod";
import type {Operation} from "@restatedev/restate-sdk-gen";
import type {Agent, AgentOptions, RunOptions, RunResult} from "./types.js";
import {runAgent} from "./agent-run.js";
import {streamRun} from "./agent-stream.js";
import {positiveInteger as limit} from "./limits.js";

/** Embeddable task loop. Definitions are reusable; every mutable object is run-local. */
export function agent<C = undefined, O = string>(options: AgentOptions<C, O>): Agent<C, O> {
  const maxSteps = limit(options.maxSteps ?? 10, "maxSteps");
  const maxToolCalls = limit(options.maxToolCalls ?? 128, "maxToolCalls");
  const maxToolDepth = limit(options.maxToolDepth ?? 16, "maxToolDepth");
  const maxOutputTokens = limit(options.maxOutputTokens ?? 4096, "maxOutputTokens");
  // Output policies receive parsed values and validation runs again afterward.
  // Requiring a representable output schema rejects transforms that would run twice.
  const outputSchema = options.output ? z.toJSONSchema(options.output) : undefined;
  const maxOutputChars = limit(options.maxOutputChars ?? 128000, "maxOutputChars");

  const config = {
    maxSteps,
    maxToolCalls,
    maxToolDepth,
    maxOutputTokens,
    maxOutputChars,
    outputSchema,
  };
  function run(input: string, runOptions?: RunOptions<C>): Operation<RunResult<O>> {
    return runAgent(input, options, config, runOptions);
  }

  return {
    definition: options,
    run,
    *stream(
      input: string,
      runOptions?: RunOptions<C>,
    ): Operation<import("./types.js").AgentStream<O>> {
      return yield* streamRun((emit) =>
        run(input, {
          ...runOptions,
          *onUpdate(event, context) {
            if (runOptions?.onUpdate) yield* runOptions.onUpdate(structuredClone(event), context);
            yield* emit(event);
          },
        } as RunOptions<C>),
      );
    },
  };
}
