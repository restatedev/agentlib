import {isRestatePromise, type RestatePromise} from "@restatedev/restate-sdk";
import {adopt} from "@restate-agents/core";
import type {Operation} from "@restatedev/restate-sdk-gen";

/** Hooks may return immediately or wait on one durable SDK operation. */
export function* resolveHook<T>(result: T | RestatePromise<T>): Operation<T> {
  if (
    result !== null &&
    typeof result === "object" &&
    typeof Reflect.get(result, "then") === "function"
  ) {
    const promise = result as Promise<T>;
    if (!isRestatePromise(promise)) {
      throw new TypeError("Promise hooks must return a value or a RestatePromise.");
    }
    return yield* adopt(promise);
  }
  return result as T;
}
