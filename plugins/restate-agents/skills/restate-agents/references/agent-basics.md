# Agent basics

Lessons:
[01_hello.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/01_hello.ts),
[04_structured_output.ts](https://github.com/restatedev/agentsdk/blob/main/packages/examples/src/lessons/04_structured_output.ts)

## Define once, run in a handler

```ts
import * as restate from "@restatedev/restate-sdk-gen";
import {agent} from "@restate-agents/core";
import {z} from "zod";

const assistant = agent({
  model, // see models-and-testing.md
  instructions: "Answer briefly.",
  maxSteps: 6, // model calls per run, including the final answer (default 10)
});

export const hello = restate.service({
  name: "Hello",
  handlers: {
    ask: restate.schemas({input: z.string().min(1), output: z.string()}, function* (message) {
      const result = yield* assistant.run(message);
      return replyText(result);
    }),
  },
});
```

A **run** completes one task. A **step** is one model call inside the run,
followed by the tools it asked for. Each request above starts a fresh run
with no history.

## RunResult

```ts
type RunResult<O> = {steps: number; messages: Message[]} & (
  | {status: "completed"; output: O}
  | {status: "stopped"; reason: "max_steps"; output?: string}
  | {status: "interrupted"; reason: string; output?: string}
);
```

A stopped or interrupted run still gets a short summary in `output`, made by
a tool-free model call (`finalize`, which defaults to the agent's model; pass
`finalize: false` to skip it). The lessons use two helpers; copy them into
your app:

```ts
import {TerminalError} from "@restatedev/restate-sdk";
import type {RunResult} from "@restate-agents/core";

/** The answer, or a short explanation when the run ended without one. */
export function replyText(result: RunResult): string {
  if (result.status === "completed") return result.output;
  return result.output ?? `Agent ${result.status}: ${result.reason}`;
}

/** A stopped or interrupted run must not silently become a successful stage. */
export function completedOutput<T>(result: RunResult<T>): T {
  if (result.status !== "completed")
    throw new TerminalError(`Agent ${result.status}: ${result.reason}`);
  return result.output;
}
```

Use `replyText` when a person reads the answer, and `completedOutput` when
the output feeds the next step of a workflow.

## Typed output

Give the agent a Zod `output` schema. The SDK asks the model for that shape,
validates it, and asks again on a mismatch. `result.output` is then typed.

```ts
const classification = z.object({
  category: z.enum(["billing", "technical", "other"]),
  summary: z.string(),
});

const triage = agent({
  model,
  instructions: "Classify the support request and summarize it in one sentence.",
  output: classification,
});

// in a handler with output: classification
return completedOutput(yield* triage.run(message));
```

Typed output is how agents plug into ordinary code: a router returns
`{specialist}`, a reviewer returns `{approved, feedback}`, and a planner
returns `{questions}`. The schema must be representable as JSON Schema;
transforms are not supported.

## Instructions from context

`instructions` can be a generator that reads the run's `context`, which is
useful when the prompt depends on per-request data:

```ts
const worker = agent<{sources: Source[]}>({
  model,
  *instructions({context}) {
    return `Answer only from these sources: ${context.sources.map((s) => s.id).join(", ")}`;
  },
});
yield* worker.run(question, {context: {sources}});
```

When the agent declares a context type, `run` requires `context`. The same
value reaches every tool and guardrail, but never the model's tool schemas.
This makes it the place for trusted data.

## Limits

`maxSteps`, `maxToolCalls`, `maxToolDepth`, `maxOutputChars`, and
`maxOutputTokens` bound a run. `maxSteps` is a loop bound, not a retry
count. Retries are configured on the model adapter and on each tool.
