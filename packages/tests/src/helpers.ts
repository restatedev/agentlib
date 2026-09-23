import type {Context} from "@restatedev/restate-sdk";
import type {ConversationStore} from "@restate-agents/core";

/** A handler context for the in-process scheduler; these tests need no Restate server. */
export function testContext(id = "test"): Context {
  return {
    request: () => ({id, attemptCompletedSignal: new AbortController().signal}),
  } as unknown as Context;
}

/** An in-memory conversation store; `values` exposes what was written. */
export function memoryStore() {
  const values = new Map<string, unknown>();
  const store: ConversationStore = {
    *get<T>(key: string) {
      return structuredClone(values.get(key)) as T | undefined;
    },
    *set(key, value) {
      values.set(key, structuredClone(value));
    },
  };
  return {store, values};
}
