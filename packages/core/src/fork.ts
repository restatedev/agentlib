import type {Message} from "./types.js";

/** Set on a run's context so that `agentTool(agent, {fork: true})` can copy the run's view. */
export const FORK_SOURCE = Symbol("agentlib.forkSource");
/** Set on the run options of a forked sub-agent. */
export const FORKED = Symbol("agentlib.forked");

export type ForkSource = {
  /** The messages of the run's latest model request, after its beforeStep hooks:
   * what the model saw and the provider cached. Only complete call/result pairs. */
  view(): readonly Message[];
  /** Whether this run is itself a fork. */
  forked: boolean;
};

/** Precedes the delegated task in a fork's input message. */
export const FORK_PREAMBLE =
  "[Forked sub-agent] You are a copy of the agent whose conversation is above, " +
  "started to do one delegated task. Do only the task below, and do it yourself: " +
  "a fork cannot delegate. Use what the conversation above already established " +
  "instead of finding it again. When you are done, reply without calling tools; " +
  "the agent that delegated sees only that reply, so put everything it needs in it.\n\n" +
  "Task:\n";
