import {z} from "zod";
import type {Operation} from "@restatedev/restate-sdk-gen";
import type {Agent, AgentOptions, RunOptions, RunResult} from "./types.js";
import {runAgent, type RunConfiguration} from "./agent-run.js";
import {positiveInteger} from "./limits.js";

/** Embeddable task loop. Definitions are reusable; every mutable object is run-local. */
export function agent<C = undefined, O = string>(options: AgentOptions<C, O>): Agent<C, O> {
  const maxSteps = positiveInteger(options.maxSteps ?? 10, "maxSteps");
  const maxToolCalls = positiveInteger(options.maxToolCalls ?? 128, "maxToolCalls");
  const maxToolDepth = positiveInteger(options.maxToolDepth ?? 16, "maxToolDepth");
  const maxOutputTokens = positiveInteger(options.maxOutputTokens ?? 4096, "maxOutputTokens");
  // Output policies receive parsed values and validation runs again afterward.
  // Requiring a representable output schema rejects transforms that would run twice.
  const outputSchema = options.output ? z.toJSONSchema(options.output) : undefined;
  const maxOutputChars = positiveInteger(options.maxOutputChars ?? 128000, "maxOutputChars");
  let compaction: RunConfiguration["compaction"];
  if (options.compaction) {
    const maxChars = positiveInteger(options.compaction.maxChars ?? 400000, "compaction.maxChars");
    const retainChars = positiveInteger(
      options.compaction.retainChars ?? Math.floor(maxChars / 4),
      "compaction.retainChars",
    );
    if (retainChars >= maxChars)
      throw new TypeError("compaction.retainChars must be less than compaction.maxChars");
    compaction = {maxChars, retainChars};
  }

  const config = {
    maxSteps,
    maxToolCalls,
    maxToolDepth,
    maxOutputTokens,
    maxOutputChars,
    outputSchema,
    compaction,
  };
  function run(input: string, runOptions?: RunOptions<C>): Operation<RunResult<O>> {
    return runAgent(input, options, config, runOptions);
  }

  return {
    definition: options,
    run,
  };
}
