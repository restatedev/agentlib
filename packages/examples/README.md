# Agent examples

Each example owns its Restate handlers. The two sets use different entry points:

- [Coroutine examples](src/coroutine): `@restate-agents/core`, generator tools, and `yield* agent.run(...)`.
- [Promise examples](src/promise): `@restate-agents/promise`, regular SDK tools, and `await agent.run(ctx, ...)`.

Each set has its own endpoint; `pnpm dev` also serves both sets together.

## Choose an example

Read the examples in this order to introduce one orchestration pattern at a time:

| Example                                              | Main lesson                                         | Follow in the source                                                                |
| ---------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Promise support](src/promise/regular-sdk.ts)        | Embed an agent in an ordinary async handler         | Load history → run agent with tools → save history and status                       |
| [Promise review](src/promise/evaluator-optimizer.ts) | Compose sequential runs in regular SDK handlers     | Typed drafts and reviews with `await`, using the same loop as the coroutine version |
| [Code review](src/coroutine/evaluator-optimizer.ts)  | Compose sequential runs with typed outputs          | Draft → review → feedback → next draft, with a three-iteration limit                |
| [Racing agents](src/coroutine/racing-agents.ts)      | Compose concurrent runs in one invocation           | Spawn → first successful completion → interrupt and join peers                      |
| [Research report](src/coroutine/research-report.ts)  | Distribute work across child invocations            | Plan → parallel worker RPCs → guarded findings → synthesis                          |
| [Support session](src/coroutine/ai-session.ts)       | Let the application own a conversation and controls | Persist history → run → publish updates → resolve approvals or steering             |

A **run** completes one task; a **step** is one planning model call inside that
run. The evaluator starts fresh runs for successive drafts. A handoff in the
support example stays within its current run. See the [glossary](../../CONTEXT.md)
for these terms and the distinction between interruption and invocation cancellation.

The three workflow examples keep orchestration and cancellation cleanup in their
own files. Their shared helper accepts only completed run results: an interrupted
or exhausted run cannot silently become a successful workflow stage.

## Start

From the workspace root, with a Restate server running:

```sh
pnpm install --frozen-lockfile
export OPENAI_API_KEY=...
export AGENT_MODEL=gpt-5.6-luna
pnpm dev:promise    # Support tools and code review
# Or: pnpm dev:coroutine
# Or: pnpm dev      # Both sets
```

In another terminal, register or rediscover the endpoint:

```sh
pnpm dlx @restatedev/restate deployments register http://localhost:9080
```

The curl commands use the conventional local ingress URL. If your server uses a
scoped call prefix, set the same prefix as your existing request, for example:

```sh
RESTATE_CALL_URL='http://[fd07:b51a:cc66::2]:8080/restate/call'
```

Otherwise use:

```sh
RESTATE_CALL_URL=http://localhost:8080
```

The shared model is defined in [shared.ts](src/shared.ts). `openAIModel` defaults
GPT-5.6 function-tool requests to `reasoning_effort: "none"` to avoid the default
Luna model's Chat Completions tool/reasoning compatibility error.
Explicit model settings are preserved. Each example declares its agents and
exports its services directly. Change an agent's `model` field to use another
adapter or gateway.

## Regular SDK: before, agent, after

[regular-sdk.ts](src/promise/regular-sdk.ts) uses a normal `restate.ObjectContext` handler.
It loads history with `await ctx.get(...)`, awaits the agent through the public
`@restate-agents/promise` entry point, then saves history and the run status with
`ctx.set(...)`:

```ts
const result = await support.run(ctx, input.message, {messages});
```

The agent has two tools: `lookupTicket` returns `ctx.run(...)` from `tool`, and
`refundPolicy` returns `ctx.serviceClient(supportPolicies).refundPolicy()` from
`handlerTool`. Both callbacks receive the current handler's `ctx`; `handlerTool`
also cancels an unfinished child call when interrupted. Both services are
registered by `pnpm dev`.

```sh
curl --globoff "$RESTATE_CALL_URL/RegularSdkSupport/bob/ask" \
  --json '{"message":"Look up ticket T-42 and tell me the refund policy."}'
```

A later call with the same key reuses the saved conversation. A stopped or
interrupted run saves its actual status; a thrown failure skips the following
state writes and propagates to Restate.

Tool callbacks return a `RestatePromise` directly; an `async` wrapper or `.then()`
produces a native promise and is rejected. The adapter owns coroutine execution
and binds `ctx` separately for each run. Tool `before`, `after`, and dynamic
`needsApproval` hooks return synchronous values or `RestatePromise`s. Their
metadata argument contains application data and call details without coroutine
operations. Model adapters are shared with core; streaming, conversation
abstractions, and agent-level coroutine hooks use `@restate-agents/core`.

The adapter uses the local `adopt` backport, so the workspace pins the coroutine
SDK to 1.17.1 until upstream `internal.adopt` is released.

## Support session

[ai-session.ts](src/coroutine/ai-session.ts) demonstrates persisted conversations and
compaction, deferred search, PTC, handoffs, background tools, approvals, steering,
interruption, and optional MCP. Ticket effects are demonstrations. Its handlers
expose history, approval, steering, interruption, and run status.

```sh
curl --globoff "$RESTATE_CALL_URL/AiSession/bob/doTurn" \
  --json '{"message":"What can you do?"}'
```

## Research report: orchestrator and workers

[research-report.ts](src/coroutine/research-report.ts) creates a typed plan of 2–4 questions,
starts one `ResearchWorker` RPC per question, waits for the workers concurrently,
and synthesizes their findings. Sources are provided with the request; workers
read them through tools. A run-level guard rejects citations to sources the worker
did not read. Cancelling the parent interrupts its tasks and cancels unfinished RPCs.

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

The result contains `report`, `findings`, and `taskCount`. This is a bounded document
research example; it does not browse the web. Citation IDs are checked against tool
reads, while the factual quality and final prose still depend on the model.

The planner and writer run inside the report invocation. Each worker has its own
invocation and private source context. Reading a source deliberately makes its
contents visible to that worker's model; passing it as context alone does not.

## Code review: evaluator and optimizer

[evaluator-optimizer.ts](src/coroutine/evaluator-optimizer.ts) generates a TypeScript draft,
evaluates it with a typed `{approved, feedback}` result, and passes the previous
draft and feedback into the next iteration. It stops after acceptance or three
iterations. Each stage has a distinct run name for stable event IDs.

```sh
curl --globoff "$RESTATE_CALL_URL/CodeReview/generate" \
  --json '{"task":"Implement a TypeScript function that returns the first item of an array, or undefined for an empty array."}'
```

The result includes `status: "accepted" | "exhausted"`, the last `code`, iteration
count, and every review. Code is returned as text; it is never executed. Acceptance
is the model's review decision, not a compiler or test-suite result.

For example, a rejected first draft followed by an approved revision returns
`status: "accepted"`, `iterations: 2`, and two reviews. Three rejections return
`status: "exhausted"` with the final draft and all three reviews.

The [promise version](src/promise/evaluator-optimizer.ts) implements the same
bounded loop with regular SDK handlers and `await agent.run(ctx, ...)`:

```sh
curl --globoff "$RESTATE_CALL_URL/PromiseCodeReview/generate" \
  --json '{"task":"Read the first item safely."}'
```

## Racing agents

[racing-agents.ts](src/coroutine/racing-agents.ts) starts two embedded agents concurrently.
One aims for a short answer and the other checks assumptions. `restate.any` returns
the first successful result. A fast failure or exhausted agent does not win. The
handler interrupts and joins the losing task before returning, so its cleanup and
model cancellation execute. If both fail, the handler returns a terminal error.

```sh
curl --globoff "$RESTATE_CALL_URL/RacingAgents/answer" \
  --json '{"question":"How should a durable workflow handle external side effects?"}'
```

The result contains `winner` and `answer`. Both calls start, so this pattern can
consume more tokens than a single run. The two agents share the configured model
with different instructions; set their `model` fields separately to compare providers.

## Provenance and validation

These are fresh coroutine-native implementations of patterns from
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
They verify parallel RPC execution, committed effects occurring once,
feedback propagation, bounded exhaustion, first-success racing, and loser cleanup.
The tests need Docker and make no paid model calls.

To modify a workflow, edit its agents and handlers directly. The
[example integration tests](../tests/src/examples.integration.ts) invoke those
same exported services through the Restate client and check returned results
and observable effects.
