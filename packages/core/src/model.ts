import {run, type RetryOptions} from "@restatedev/restate-sdk-gen";
import type {Model, ModelRequest, ModelResponse} from "./types.js";
import {modelResponse} from "./validation.js";

/** Adapt asynchronous model I/O into one journaled, cancellable operation.
 * Without `retry`, a failing call follows the invocation's retry policy, which
 * pauses the invocation by default once its retries run out. `retry.maxAttempts`
 * bounds the call instead: the run then fails when the attempts run out. */
export function journaledModel(
  complete: (request: ModelRequest, options: {signal: AbortSignal}) => Promise<ModelResponse>,
  options: {name?: string; retry?: RetryOptions} = {},
): Model {
  return function* (request) {
    return yield* run(async ({signal}) => modelResponse(await complete(request, {signal})), {
      name: options.name ?? "Ask model",
      retry: options.retry,
    });
  };
}
