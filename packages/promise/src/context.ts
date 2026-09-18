import type {Context} from "@restatedev/restate-sdk";
import {contextLocal} from "@restatedev/restate-sdk-gen";

// The handle is shared; its value belongs to the scheduler of one agent run.
export const restateContext = contextLocal<Context>();

export function currentContext(): Context {
  const ctx = restateContext.get();
  if (!ctx) throw new Error("Promise tools must run inside a promise agent.");
  return ctx;
}
