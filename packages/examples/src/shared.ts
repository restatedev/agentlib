import {TerminalError} from "@restatedev/restate-sdk";
import type {RunResult} from "@restate-agents/core";
import {openAIModel} from "@restate-agents/core/openai";

// Construction is lazy: importing the examples needs no provider credentials.
export const exampleModel = openAIModel({model: process.env.AGENT_MODEL ?? "gpt-5.6-luna"});

/** A stopped/interrupted child cannot silently become a successful workflow stage. */
export function completedOutput<T>(result: RunResult<T>): T {
  if (result.status !== "completed")
    throw new TerminalError(`Agent ${result.status}: ${result.reason}`);
  return result.output;
}
