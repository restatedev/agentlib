import {isRestatePromise, type RestatePromise} from "@restatedev/restate-sdk";
import {channel, type Future} from "@restatedev/restate-sdk-gen";

/**
 * Adopt a regular SDK promise from the same invocation into an active coroutine.
 * Pass the RestatePromise directly, without an async wrapper or `.then()`.
 * Returns a plain Future; child-invocation cancellation stays with the caller.
 *
 * Temporary backport for restate-sdk-gen 1.17.2 until internal.adopt is released:
 * https://github.com/restatedev/sdk-typescript/pull/797
 */
export function adopt<T>(promise: RestatePromise<T>): Future<T> {
  if (!isRestatePromise(promise)) {
    throw new TypeError(
      "adopt requires a RestatePromise. Pass the SDK promise directly, without async or .then().",
    );
  }

  // A channel allocates a Future without a journal entry. Reuse its iterator
  // and private SDK symbols, replacing only the backing before it is yielded.
  const future = channel<T>().receive;
  const backing = Object.getOwnPropertySymbols(future).find(
    (key) => key.description === "restateFutureBacking",
  );
  if (!backing || !Reflect.set(future, backing, {kind: "journal", promise})) {
    throw new Error("adopt is incompatible with this version of @restatedev/restate-sdk-gen.");
  }
  return future;
}
