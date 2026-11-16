// Forks: a copy of the running agent that does one task. A fork is a copy of
// the run, not a new run of an agent definition: it starts from the run's
// history as it stood when the model called the fork tool, with the same root
// and active agent, policies, configuration, run-level tools, skills, and
// loaded deferred tools. Its first request repeats the request that called the
// tool, so a provider serves it from the prompt cache, and every reference in
// the inherited messages, such as a preview's ref, resolves in the fork.
//
// The fork reads that state from the parent run's memory, not from the
// journal; a replay rebuilds it by running the same steps again.
import {z} from "zod";
import {ToolCancelled, ToolError} from "./errors.js";
import {assertNotForked, forkSource} from "./fork-source.js";
import {tool} from "./tool.js";
import {positiveInteger} from "./limits.js";
import {jsonSchema} from "./validation.js";
import type {BuiltinToolOptions} from "./builtins.js";
import type {Tool, ToolContext} from "./types.js";

export {FORK_SOURCE, type ForkSource} from "./fork-source.js";

/** Precedes the task in a fork's input message. */
export const FORK_PREAMBLE =
  "[Forked sub-agent] You are a copy of the agent whose conversation is above, " +
  "started to do one delegated task. Do only the task below, and do it yourself: " +
  "a fork cannot delegate. Use what the conversation above already established " +
  "instead of finding it again. When you are done, reply without calling tools; " +
  "the agent that delegated sees only that reply, so put everything it needs in it.\n\n" +
  "Task:\n";

const forkedTask = z.object({
  task: z
    .string()
    .min(1)
    .describe("The task for the copy, which sees your conversation up to this step."),
});

/** Forks a run can have running at once by default, as many as Codex runs sub-agents. */
const DEFAULT_MAX_CONCURRENT = 6;

/** Start a copy of the running agent to do one task. The copy sees the
 * conversation up to the step that called this tool, and has the run's tools,
 * policies, and limits; its answer becomes the tool result. Calls in one step
 * run in parallel. A fork cannot start forks or sub-agents, and saves nothing
 * to the conversation. It skips the root's beforeRun and afterRun, and replies
 * in plain text even when the agent has an output schema: its input and answer
 * belong to the parent run, as a tool call and its result.
 *
 * `maxConcurrent` (default 6) bounds how many forks of one run run at once,
 * counting every fork tool of the run; a call past it returns a `fork_limit`
 * error, and the model can fork again once a fork finishes. */
export function forkTool<C = unknown>(
  options: {
    background?: boolean;
    needsApproval?: boolean;
    maxConcurrent?: number;
  } & BuiltinToolOptions<{task: string}> = {},
): Tool<C> {
  const maxConcurrent = positiveInteger(
    options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    "maxConcurrent",
  );
  return tool<typeof forkedTask, C>({
    description:
      options.description ??
      "Start a copy of yourself that sees this conversation so far, to do one task, and get its reply. " +
        "Call it several times in one step to run copies in parallel.",
    describe: options.describe,
    input: forkedTask,
    background: options.background,
    needsApproval: options.needsApproval,
    *execute({task}, context) {
      const call = context as ToolContext<unknown>;
      const source = forkSource(call);
      if (!source) throw new ToolError("This tool can only fork an agent run", "fork_unavailable");
      assertNotForked(call);
      const result = yield* source.fork(task, call, {maxConcurrent});
      if (result.status === "completed") return jsonSchema.parse(result.output);
      if (result.status === "interrupted") throw new ToolCancelled(result.reason);
      throw new ToolError(
        result.output ?? `The fork stopped before finishing: ${result.reason}`,
        "agent_stopped",
      );
    },
  });
}
