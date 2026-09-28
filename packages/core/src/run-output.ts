import {CancelledError} from "@restatedev/restate-sdk";
import {InterruptedError, type Operation} from "@restatedev/restate-sdk-gen";
import {GuardrailError, ModelProtocolError} from "./errors.js";
import type {Message, Model, OutputCandidate, OutputDecision, RunResult} from "./types.js";
import {modelResponse} from "./validation.js";

/** Summaries may fail, but native cancellation must still reach the caller.
 * `messages` is the model's view of the run, which compaction may have shortened. */
export function* summarizeStoppedRun<O>(
  result: RunResult<O>,
  finalize: Model,
  messages: readonly Message[] = result.messages,
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
  let text: string;
  try {
    const final = modelResponse(yield* finalize(request));
    if (final.type !== "final") throw new ModelProtocolError("Finalization must not request tools");
    text = final.text;
  } catch (error) {
    if (error instanceof InterruptedError || error instanceof CancelledError) throw error;
    text = `The run stopped (${result.reason}); a final summary could not be generated.`;
  }
  return {...result, output: text};
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

/** A policy can replace output, never the run's lifecycle or history. */
export function applyOutputDecision<O>(
  result: RunResult<O>,
  decision: void | OutputDecision<O>,
): RunResult<O> {
  if (decision === undefined) return result;
  if (
    decision === null ||
    typeof decision !== "object" ||
    !Object.hasOwn(decision, "output") ||
    Reflect.ownKeys(decision).some((key) => key !== "output")
  )
    throw new GuardrailError("afterRun must return nothing or an object containing only output");
  if (result.status === "completed") {
    // The root output schema (or text contract) validates this before publication.
    return {...result, output: decision.output as O};
  }
  const summary: unknown = decision.output;
  if (summary !== undefined && typeof summary !== "string")
    throw new GuardrailError("A stopped or interrupted output must be a text summary");
  return {...result, output: summary};
}
