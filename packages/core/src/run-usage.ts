import type {Operation} from "@restatedev/restate-sdk-gen";
import type {Model, ModelResponse, RunUsage} from "./types.js";
import {modelResponse} from "./validation.js";

/** Tracks usage for one run and reconstructs totals from journaled model responses during replay. */
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

  wrap(model: Model): Model {
    return (request) => this.call(model(request));
  }

  *call(operation: Operation<ModelResponse>): Operation<ModelResponse> {
    const response = modelResponse(yield* operation);
    const {usage} = response;
    if (usage) {
      this.totals.inputTokens += usage.inputTokens;
      this.totals.outputTokens += usage.outputTokens;
      this.totals.totalTokens += usage.inputTokens + usage.outputTokens;
      this.totals.cachedInputTokens += usage.cachedInputTokens ?? 0;
      this.totals.cacheWriteInputTokens += usage.cacheWriteInputTokens ?? 0;
    }
    return response;
  }
}
