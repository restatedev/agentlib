import type {Operation} from "@restatedev/restate-sdk-gen";
import {guardrailDecision, mustPropagate, ToolError} from "./errors.js";
import type {
  GuardrailResult,
  Message,
  Model,
  OutputCandidate,
  OutputDecision,
  RunResult,
} from "./types.js";
import {modelResponse} from "./validation.js";

/** Summaries may fail, but cancellation and an `AgentTerminalError` must still
 * reach the caller. `messages` is the model's view of the run, which compaction
 * may have shortened. A fixed text replaces a summary that failed or is longer
 * than `maxChars`; when that does not fit either, the result has no summary. */
export function* summarizeStoppedRun<O>(
  result: RunResult<O>,
  finalize: Model,
  messages: readonly Message[] = result.messages,
  maxChars = Infinity,
): Operation<RunResult<O>> {
  if (result.status === "completed") return result;
  const request = {
    messages: [
      ...messages,
      {
        role: "user" as const,
        content: `The run stopped: ${result.reason}. Summarize completed results and unresolved work. Do not claim cancelled work succeeded. No tools are available.`,
      },
    ],
    tools: [],
  };
  let text: string | undefined;
  try {
    const final = modelResponse(yield* finalize(request));
    if (final.type !== "final") throw new Error("Finalization must not request tools");
    text = final.text;
  } catch (error) {
    if (mustPropagate(error)) throw error;
  }
  if (text === undefined || text.length > maxChars)
    text = `The run stopped (${result.reason}); a final summary could not be generated.`;
  return {...result, output: text.length > maxChars ? undefined : text};
}

/** Policies inspect an isolated candidate before its output is committed to history. */
export function createOutputCandidate<O>(result: RunResult<O>): OutputCandidate<O> {
  const candidate = structuredClone(result);
  if (candidate.output !== undefined)
    candidate.messages.push({
      role: "assistant",
      content:
        typeof candidate.output === "string" ? candidate.output : JSON.stringify(candidate.output),
    });
  // The clone isolates untyped policies; the public view is deeply readonly.
  return candidate as unknown as OutputCandidate<O>;
}

/** A policy can accept, reject or replace output, never change the run's lifecycle or
 * history. A rejected answer goes back to the model; a rejected stopped or interrupted
 * result fails the run, since no model step follows it. */
export function applyOutputDecision<O>(
  result: RunResult<O>,
  returned: GuardrailResult | OutputDecision<O>,
): RunResult<O> {
  const decision = guardrailDecision("afterRun", returned, "output");
  if (!decision) return result;
  if ("reject" in decision) throw new ToolError(decision.reject, "denied");
  if (result.status === "completed") {
    // The root output schema (or text contract) validates this before publication.
    return {...result, output: decision.replace as O};
  }
  const summary: unknown = decision.replace;
  if (summary !== undefined && typeof summary !== "string")
    throw new TypeError("A stopped or interrupted output must be a text summary");
  return {...result, output: summary};
}
