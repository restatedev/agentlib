import {z} from "zod";
import type {Operation} from "@restatedev/restate-sdk-gen";
import type {Agent, AgentOptions, RunOptions, RunResult} from "./types.js";
import {runAgent, type RunConfiguration} from "./agent-run.js";
import {positiveInteger, REPLY_RESERVE} from "./limits.js";
import {checkTool} from "./tool-catalog.js";

/** Embeddable task loop. Definitions are reusable; every mutable object is run-local. */
export function agent<C = undefined, O = string>(options: AgentOptions<C, O>): Agent<C, O> {
  // A tool no run could list fails here, at startup, rather than in every run.
  for (const [name, definition] of Object.entries(options.tools ?? {})) checkTool(name, definition);
  const maxSteps = positiveInteger(options.maxSteps ?? 10, "maxSteps");
  const maxToolCalls = positiveInteger(options.maxToolCalls ?? 128, "maxToolCalls");
  const maxToolDepth = positiveInteger(options.maxToolDepth ?? 16, "maxToolDepth");
  // Unset, it is left out of requests, so each provider picks the limit.
  const maxOutputTokens =
    options.maxOutputTokens === undefined
      ? undefined
      : positiveInteger(options.maxOutputTokens, "maxOutputTokens");
  // Output policies receive parsed values and validation runs again afterward.
  // Requiring a representable output schema rejects transforms that would run twice.
  const outputSchema = options.output ? z.toJSONSchema(options.output) : undefined;
  const maxOutputChars = positiveInteger(options.maxOutputChars ?? 128000, "maxOutputChars");
  const contextWindow =
    options.contextWindow === undefined
      ? undefined
      : positiveInteger(options.contextWindow, "contextWindow");
  if (contextWindow !== undefined && contextWindow <= (maxOutputTokens ?? REPLY_RESERVE))
    throw new TypeError(
      `contextWindow must be greater than maxOutputTokens, or ${REPLY_RESERVE} when it is unset; set maxOutputTokens for a smaller window`,
    );
  let compaction: RunConfiguration["compaction"];
  if (options.compaction !== false) {
    const settings = options.compaction ?? {};
    const maxTokens = positiveInteger(
      settings.maxTokens ?? defaultCompactionTokens(contextWindow, maxOutputTokens),
      "compaction.maxTokens",
    );
    const retainTokens = positiveInteger(
      settings.retainTokens ?? Math.max(1, Math.floor(maxTokens / 4)),
      "compaction.retainTokens",
    );
    if (retainTokens >= maxTokens)
      throw new TypeError(
        `compaction.retainTokens must be less than compaction.maxTokens (${maxTokens})`,
      );
    const {instructions} = settings;
    if (instructions !== undefined && (typeof instructions !== "string" || !instructions.trim()))
      throw new TypeError("compaction.instructions must be a nonempty string");
    compaction = {maxTokens, retainTokens, ...(instructions === undefined ? {} : {instructions})};
  }
  let toolResults: RunConfiguration["toolResults"];
  if (options.toolResults !== false) {
    const maxTokens = positiveInteger(
      options.toolResults?.maxTokens ?? 5000,
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
    contextWindow,
  };
  function run(input: string, runOptions?: RunOptions<C>): Operation<RunResult<O>> {
    return runAgent(input, options, config, runOptions);
  }

  return {
    definition: options,
    run,
  };
}

/** The view size that starts compaction when `compaction.maxTokens` is unset:
 * 90% of the room `contextWindow` leaves for input after the reply, or 170,000
 * tokens when the window is unknown. A model's window has to come from the app:
 * neither `Model` nor the AI SDK's language models carry one. 170,000 fits a
 * window of 200,000 tokens or more; a smaller model needs `contextWindow`.
 * Staying below the window check (view plus reply) lets the run ask its own
 * model for the summary at the end of its cached request, with room left for
 * the note and the summary. */
function defaultCompactionTokens(
  contextWindow: number | undefined,
  maxOutputTokens: number | undefined,
): number {
  if (contextWindow === undefined) return 170000;
  // At least 2, so the default retainTokens stays below it even for a tiny window.
  return Math.max(2, Math.floor((contextWindow - (maxOutputTokens ?? REPLY_RESERVE)) * 0.9));
}
