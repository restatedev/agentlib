import {run, type RetryOptions} from "@restatedev/restate-sdk-gen";
import type {Model, ModelRequest, ModelResponse} from "./types.js";
import {modelResponse} from "./validation.js";

/** Adapt asynchronous model I/O into one journaled, cancellable operation. */
export function journaledModel(
  complete: (request: ModelRequest, options: {signal: AbortSignal}) => Promise<ModelResponse>,
  options: {name?: string; retry?: RetryOptions} = {},
): Model {
  return function* (request) {
    return yield* run(async ({signal}) => modelResponse(await complete(request, {signal})), {
      name: options.name ?? "Ask model",
      retry: options.retry ?? {maxAttempts: 3},
    });
  };
}
