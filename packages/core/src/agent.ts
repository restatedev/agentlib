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
    const maxTokens = positiveInteger(
      options.compaction.maxTokens ?? 100000,
      "compaction.maxTokens",
    );
    const retainTokens = positiveInteger(
      options.compaction.retainTokens ?? Math.floor(maxTokens / 4),
      "compaction.retainTokens",
    );
    if (retainTokens >= maxTokens)
      throw new TypeError("compaction.retainTokens must be less than compaction.maxTokens");
    compaction = {maxTokens, retainTokens};
  }
  let toolResults: RunConfiguration["toolResults"];
  if (options.toolResults !== false) {
    const maxTokens = positiveInteger(
      options.toolResults?.maxTokens ?? 1500,
      "toolResults.maxTokens",
    );
    const previewTokens = positiveInteger(
      options.toolResults?.previewTokens ?? Math.floor(maxTokens / 2),
      "toolResults.previewTokens",
    );
    if (previewTokens >= maxTokens)
      throw new TypeError("toolResults.previewTokens must be less than toolResults.maxTokens");
    toolResults = {maxTokens, previewTokens};
  }

  const config = {
    maxSteps,
    maxToolCalls,
    maxToolDepth,
    maxOutputTokens,
    maxOutputChars,
    outputSchema,
    compaction,
    toolResults,
  };
  function run(input: string, runOptions?: RunOptions<C>): Operation<RunResult<O>> {
    return runAgent(input, options, config, runOptions);
  }

  return {
    definition: options,
    run,
  };
}
