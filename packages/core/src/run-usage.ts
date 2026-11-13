import type {Operation} from "@restatedev/restate-sdk-gen";
import type {Model, ModelResponse, ModelUsage, RunUsage} from "./types.js";
import {reportedUsage} from "./validation.js";

/** The tracker a sub-agent run adds its totals to: set on a run's context, so
 * tool contexts carry it, and passed by `agentTool` in the sub-agent's options. */
export const PARENT_USAGE = Symbol("agentlib.parentUsage");

/** Sums the usage one run's model calls report. Every counted response comes
 * from the journal, so a replay rebuilds the same totals. */
export class RunUsageTracker {
  private readonly totals: RunUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
  };

  snapshot(): RunUsage {
    return {...this.totals};
  }

  add(usage: ModelUsage): void {
    this.totals.inputTokens += usage.inputTokens;
    this.totals.outputTokens += usage.outputTokens;
    this.totals.totalTokens += usage.inputTokens + usage.outputTokens;
    this.totals.cachedInputTokens += usage.cachedInputTokens ?? 0;
    this.totals.cacheWriteInputTokens += usage.cacheWriteInputTokens ?? 0;
  }

  /** Counts the usage a model call reports, before the caller validates the rest of the response. */
  *counted(call: Operation<ModelResponse>): Operation<ModelResponse> {
    const response = yield* call;
    const usage = reportedUsage(response);
    if (usage) this.add(usage);
    return response;
  }

  /** The same model, counting the usage of each call. */
  count(model: Model): Model {
    return (request) => this.counted(model(request));
  }
}

const failedRuns = new WeakMap<object, RunUsage>();

/** The usage totals of the run that threw `error`, or undefined when no run
 * threw it. When several runs threw the same error, it holds the last one's
 * totals; for nested runs that is the outermost, which includes the others. */
export function usageOf(error: unknown): RunUsage | undefined {
  const usage = typeof error === "object" && error !== null ? failedRuns.get(error) : undefined;
  return usage && {...usage};
}

/** Records a failed run's totals for `usageOf` without changing the error. */
export function recordFailedRun(error: unknown, usage: RunUsage): void {
  if (typeof error === "object" && error !== null) failedRuns.set(error, usage);
}
