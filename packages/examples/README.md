# Agent tutorial

Choose a flavor and read its numbered files from `01` onward:

- [gensdk](src/gensdk): `@restate-agents/core`, generator tools, and `yield* agent.run(...)`.
- [Promise](src/promise): `@restate-agents/promise`, regular SDK tools, and `await agent.run(ctx, ...)`.

The first five lessons match across both flavors. Each file stands alone and
introduces one concept using what you learned earlier; you do not need to import
or edit previous lessons. Later lessons combine those concepts into workflows.
The `app.ts` files only register the services, and [shared.ts](src/shared.ts)
configures the model.

| Lesson | New concept                               | gensdk source                                                     | Promise source                                                     |
| ------ | ----------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| 01     | One agent, one request                    | [01_hello.ts](src/gensdk/01_hello.ts)                             | [01_hello.ts](src/promise/01_hello.ts)                             |
| 02     | A tool with validated arguments           | [02_tools.ts](src/gensdk/02_tools.ts)                             | [02_tools.ts](src/promise/02_tools.ts)                             |
| 03     | Conversation history between requests     | [03_conversation.ts](src/gensdk/03_conversation.ts)               | [03_conversation.ts](src/promise/03_conversation.ts)               |
| 04     | Validated, typed output                   | [04_structured_output.ts](src/gensdk/04_structured_output.ts)     | [04_structured_output.ts](src/promise/04_structured_output.ts)     |
| 05     | A bounded draft-and-review loop           | [05_evaluator_optimizer.ts](src/gensdk/05_evaluator_optimizer.ts) | [05_evaluator_optimizer.ts](src/promise/05_evaluator_optimizer.ts) |
| 06     | Concurrent agents / support integration   | [06_racing_agents.ts](src/gensdk/06_racing_agents.ts)             | [06_support_session.ts](src/promise/06_support_session.ts)         |
| 07     | Parallel worker RPCs and synthesis        | [07_research_report.ts](src/gensdk/07_research_report.ts)         | —                                                                  |
| 08     | Approvals, handoffs, and session controls | [08_support_session.ts](src/gensdk/08_support_session.ts)         | —                                                                  |

## Start

From the workspace root, with a Restate server running:

```sh
pnpm install --frozen-lockfile
export OPENAI_API_KEY=...
# Optional: export AGENT_MODEL=...
pnpm dev:gensdk
# Or: pnpm dev:promise
# Or: pnpm dev          # Both flavors
```

In another terminal, register or rediscover the endpoint:

```sh
pnpm dlx @restatedev/restate deployments register http://localhost:9080
RESTATE_CALL_URL=http://localhost:8080
```

If your server uses a scoped call prefix, use that instead, for example:

```sh
RESTATE_CALL_URL='http://[fd07:b51a:cc66::2]:8080/restate/call'
```

The commands below show the gensdk endpoints. For lessons 01–05, prepend
`Promise` to the service name to call the promise version: `Hello/ask` becomes
`PromiseHello/ask`, and `ChatSession/bob/ask` becomes `PromiseChatSession/bob/ask`.
The request bodies are identical.

## 01 — Run your first agent

Start with `agent({model})` and a single handler. The handler passes the request
to the agent and returns its result. Each call starts with no conversation history.

```sh
curl --globoff "$RESTATE_CALL_URL/Hello/ask" --json '"Say hello in one sentence."'
# Promise flavor:
curl --globoff "$RESTATE_CALL_URL/PromiseHello/ask" --json '"Say hello in one sentence."'
```

On success, the response has `status: "completed"`, the answer in `output`, and
its conversation in `messages`. Keep returning the whole result in these first
lessons so callers can also see when a run stops or is interrupted.

## 02 — Give the agent a tool

Add `instructions` and a `tools` map. `lookupTicket` declares its input with Zod
and returns a fixed demo record. The agent chooses when to call it and uses the
result in its answer.

```sh
curl --globoff "$RESTATE_CALL_URL/TicketLookup/ask" \
  --json '"What is the status of ticket T-42?"'
```

Both flavors use `asyncTool` with an ordinary `async execute(...)` callback.
The SDK journals its result, so you can replace the fixed record with an async
API call directly. The optional second argument supplies application context,
call metadata, and an `AbortSignal` for cancellable I/O.

Use `tool` when execution needs to compose SDK operations: a generator with
`yield*` in gensdk, or a callback returning a `RestatePromise` in the promise
flavor. Use `handlerTool` for typed calls to other Restate handlers.

## 03 — Remember previous turns

Change the service to a keyed Restate object. Before the run, load its saved
messages. Pass them to the agent, then save `result.messages` afterward.

```sh
curl --globoff "$RESTATE_CALL_URL/ChatSession/bob/ask" --json '"My name is Bob."'
curl --globoff "$RESTATE_CALL_URL/ChatSession/bob/ask" --json '"What is my name?"'
```

Both requests use `bob`, so the second sees the first turn. A different key gets
its own history. This lesson stores the full history; the final gensdk lesson
adds conversation compaction and lifecycle controls.

## 04 — Return structured data

Add an `output` schema to describe the result. The SDK validates the model's
answer and gives the caller a typed `output` value.

```sh
curl --globoff "$RESTATE_CALL_URL/TicketTriage/classify" \
  --json '"I was charged twice for my subscription."'
```

A completed result contains an object such as
`{"category":"billing","summary":"The customer reports a duplicate subscription charge."}`
in `output`. Lesson 05 uses this same mechanism to connect two agents.

## 05 — Compose a draft-and-review loop

One agent returns `{code}`; another returns `{approved, feedback}`. The handler
passes the draft and feedback into the next iteration, stopping at acceptance
or after three attempts. Each stage has a distinct run name.

```sh
curl --globoff "$RESTATE_CALL_URL/CodeReview/generate" \
  --json '{"task":"Read the first item of an array safely, returning undefined when it is empty."}'
```

The result includes `status: "accepted" | "exhausted"`, the last `code`, iteration
count, and every review. Acceptance is the model's review decision; the code is
returned as text and never executed. The shared `completedOutput` helper makes
a stopped or interrupted run fail the stage instead of advancing the workflow.

A **run** completes one task; a **step** is one planning model call inside that
run. This loop starts fresh runs for successive drafts. See the
[glossary](../../CONTEXT.md) for the lifecycle terms.

## Promise 06 — Put tools and history together

The promise support lesson combines lessons 02 and 03, then adds a guard and a
typed service call. `lookupTicket` uses `asyncTool`; `refundPolicy` uses
`handlerTool` and `ctx.serviceClient(supportPolicies).refundPolicy()`.

```sh
curl --globoff "$RESTATE_CALL_URL/RegularSdkSupport/bob/ask" \
  --json '{"message":"Look up ticket T-42 and tell me the refund policy."}'
```

The handler loads history, runs the agent, then saves history and its actual
status. A thrown failure skips those state writes. `handlerTool` cancels an
unfinished child call when interrupted. Both services are registered by
`pnpm dev:promise` and `pnpm dev`.

Tool `before`, `after`, and dynamic `needsApproval` hooks return synchronous
values or `RestatePromise`s. Model adapters are shared with core; streaming,
conversation abstractions, and agent-level generator hooks use
`@restate-agents/core`.

## gensdk 06 — Race concurrent agents

Spawn two agents and use `restate.any` to take the first successful answer. An
error or exhausted run cannot win. Interrupt and join the other task so its
cleanup finishes before returning; if both fail, return a terminal error.

```sh
curl --globoff "$RESTATE_CALL_URL/RacingAgents/answer" \
  --json '{"question":"How should a durable workflow handle external side effects?"}'
```

The result contains `winner` and `answer`. Both agents start, so the pattern can
consume more tokens than a single run. They share a model with different
instructions; change their `model` fields to compare providers.

## gensdk 07 — Delegate to parallel workers

The planner returns 2–4 questions. Start a `ResearchWorker` RPC for each, await
them concurrently, and synthesize the findings. Each worker gets its own source
context and reads supplied evidence through tools. A guard rejects citations to
sources it did not read. Parent cancellation also cancels unfinished worker calls.

```sh
curl --globoff "$RESTATE_CALL_URL/ResearchReport/generate" --json '{
  "topic": "Explain recovery and external side effects",
  "sources": [
    {
      "id": "journal",
      "title": "Durable execution",
      "text": "Restate journals completed operations and reuses their results during replay."
    },
    {
      "id": "effects",
      "title": "Idempotency",
      "text": "An external effect can repeat if its result was not committed. Use stable idempotency keys for external mutations."
    }
  ]
}'
```

The result contains `report`, `findings`, and `taskCount`. This example uses
supplied documents and does not browse the web. Citation IDs are checked against
tool reads; factual quality and final prose still depend on the model.

## gensdk 08 — Build a controlled support session

The final lesson combines persisted conversations and compaction, deferred tool
search, programmatic tool calls, handoffs, background tools, approvals, steering,
interruption, and optional MCP. The application's handlers expose history,
approvals, controls, and run status. Ticket effects are demonstrations.

```sh
curl --globoff "$RESTATE_CALL_URL/AiSession/bob/doTurn" \
  --json '{"message":"What can you do?"}'
```

Optional MCP configuration uses `MCP_SERVER_URL`, `MCP_PROTOCOL`, and `MCP_TOKEN`.
This is the full integration reference after the smaller lessons.

## Model configuration

[shared.ts](src/shared.ts) configures the example model. `openAIModel` defaults
GPT-5.6 function-tool requests to `reasoning_effort: "none"` to avoid the default
Luna model's Chat Completions tool/reasoning compatibility error. Explicit model
settings are preserved. Change an agent's `model` field to use another adapter
or gateway.

The promise adapter uses the local `adopt` backport, so the workspace pins the
generator SDK to 1.17.1 until upstream `internal.adopt` is released.

## Provenance and validation

The advanced workflow lessons adapt patterns from
[`restatedev/ai-examples`](https://github.com/restatedev/ai-examples), inspected at
commit `60d1eda2e5f3aae96db2efeba498e52367a01648`:

| Local example   | Upstream pattern                                                                                                                                                                                      | Changes in this implementation                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Research report | [workflow-orchestrator.ts](https://github.com/restatedev/ai-examples/blob/60d1eda2e5f3aae96db2efeba498e52367a01648/typescript-restate-only/tour-of-agents/src/workflow-orchestrator.ts)               | Typed bounded plan, supplied evidence, source tools and guards, cancellation bridge                    |
| Code review     | [workflow-evaluator-optimizer.ts](https://github.com/restatedev/ai-examples/blob/60d1eda2e5f3aae96db2efeba498e52367a01648/typescript-restate-only/tour-of-agents/src/workflow-evaluator-optimizer.ts) | Structured decisions, previous draft carried forward, explicit exhaustion with the last draft retained |
| Racing agents   | [racing-agents.ts](https://github.com/restatedev/ai-examples/blob/60d1eda2e5f3aae96db2efeba498e52367a01648/typescript-restate-only/tour-of-agents/src/racing-agents.ts)                               | Embedded operations, first completed success, cancellation with joined cleanup                         |

`pnpm test:integration` registers these exported services with the official
`RestateTestEnvironment` and a real `RestateContainer().alwaysReplay()`. Tests
replace the model adapter import with fixture models using Node's module mocking.
They verify the introductory lessons, conversation isolation, parallel RPC execution, committed effects occurring once,
feedback propagation, bounded exhaustion, first-success racing, and loser cleanup.
The tests need Docker and make no paid model calls.

To modify a workflow, edit its agents and handlers directly. The
[example integration tests](../tests/src/examples.integration.ts) invoke those
same exported services through the Restate client and check returned results
and observable effects.
