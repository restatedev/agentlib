import type {Operation} from "@restatedev/restate-sdk-gen";
import {ToolError} from "./errors.js";
import type {RunResult, ToolContext} from "./types.js";

/** Set on a run's context, so the fork tool can copy the run that called it. */
export const FORK_SOURCE = Symbol("agentlib.forkSource");

/** A fork tool's limits. Each fork tool passes one object on every call, and a
 * run counts its running forks per object, so each tool's limit holds on its own. */
export type ForkLimits = {readonly maxConcurrent: number};

export type ForkSource = {
  /** Whether this run is itself a fork, which cannot start forks or sub-agents. */
  forked: boolean;
  /** Runs a copy of this run, as it stood at the call's step, on `task`. Fails
   * with `fork_limit` when `maxConcurrent` forks this tool started in this run are
   * still running. */
  fork(task: string, call: ToolContext<unknown>, limits: ForkLimits): Operation<RunResult<unknown>>;
};

/** The fork source of the run that made a tool call, if the call came from a run. */
export function forkSource(context: ToolContext<unknown>): ForkSource | undefined {
  return (context as {[FORK_SOURCE]?: ForkSource})[FORK_SOURCE];
}

/** A fork does its task itself: it cannot start a fork or a sub-agent, so
 * delegation stays one level deep. */
export function assertNotForked(context: ToolContext<unknown>): void {
  if (forkSource(context)?.forked)
    throw new ToolError(
      "A forked sub-agent cannot start forks or sub-agents. Do this work yourself.",
      "fork_nested",
    );
}
