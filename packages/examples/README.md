# Coroutine-native agent examples

Each example owns its Restate handlers and embeds `@restate-agents/core` operations.
The SDK does not register those services. All examples run in the same endpoint.

## Choose an example

Read the examples in this order to introduce one orchestration pattern at a time:

| Example                                   | Main lesson                                         | Follow in the source                                                    |
| ----------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| [Code review](src/evaluator-optimizer.ts) | Compose sequential runs with typed outputs          | Draft → review → feedback → next draft, with a three-iteration limit    |
| [Racing agents](src/racing-agents.ts)     | Compose concurrent runs in one invocation           | Spawn → first successful completion → interrupt and join peers          |
| [Research report](src/research-report.ts) | Distribute work across child invocations            | Plan → parallel worker RPCs → guarded findings → synthesis              |
| [Support session](src/ai-session.ts)      | Let the application own a conversation and controls | Persist history → run → publish updates → resolve approvals or steering |

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
pnpm dev
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
Explicit model settings are preserved. The examples accept generator models in
their factory functions, so the same workflows can use another adapter or gateway.

## Support session

[ai-session.ts](src/ai-session.ts) demonstrates persisted conversations and
compaction, deferred search, PTC, handoffs, background tools, approvals, steering,
interruption, and optional MCP. Ticket effects are demonstrations. Its handlers
expose history, approval, steering, interruption, and run status.

```sh
curl --globoff "$RESTATE_CALL_URL/AiSession/bob/doTurn" \
  --json '{"message":"What can you do?"}'
```

## Research report: orchestrator and workers

[research-report.ts](src/research-report.ts) creates a typed plan of 2–4 questions,
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

[evaluator-optimizer.ts](src/evaluator-optimizer.ts) generates a TypeScript draft,
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

## Racing agents

[racing-agents.ts](src/racing-agents.ts) starts two embedded agents concurrently.
One aims for a short answer and the other checks assumptions. `restate.any` returns
the first successful result. A fast failure or exhausted agent does not win. The
handler interrupts and joins the losing task before returning, so its cleanup and
model cancellation execute. If both fail, the handler returns a terminal error.

```sh
curl --globoff "$RESTATE_CALL_URL/RacingAgents/answer" \
  --json '{"question":"How should a durable workflow handle external side effects?"}'
```

The result contains `winner` and `answer`. Both calls start, so this pattern can
consume more tokens than a single run. The factory accepts separate `quick` and
`thorough` models; the runnable defaults share one provider with different instructions.

## Provenance and validation

These are fresh coroutine-native implementations of patterns from
[`restatedev/ai-examples`](https://github.com/restatedev/ai-examples), inspected at
commit `60d1eda2e5f3aae96db2efeba498e52367a01648`:

| Local example   | Upstream pattern                                                                                                                                                                                      | Changes in this implementation                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Research report | [workflow-orchestrator.ts](https://github.com/restatedev/ai-examples/blob/60d1eda2e5f3aae96db2efeba498e52367a01648/typescript-restate-only/tour-of-agents/src/workflow-orchestrator.ts)               | Typed bounded plan, supplied evidence, source tools and guards, cancellation bridge                    |
| Code review     | [workflow-evaluator-optimizer.ts](https://github.com/restatedev/ai-examples/blob/60d1eda2e5f3aae96db2efeba498e52367a01648/typescript-restate-only/tour-of-agents/src/workflow-evaluator-optimizer.ts) | Structured decisions, previous draft carried forward, explicit exhaustion with the last draft retained |
| Racing agents   | [racing-agents.ts](https://github.com/restatedev/ai-examples/blob/60d1eda2e5f3aae96db2efeba498e52367a01648/typescript-restate-only/tour-of-agents/src/racing-agents.ts)                               | Embedded operations, first completed success, cancellation with joined cleanup                         |

`pnpm test:integration` runs these exported factories against the official
`RestateTestEnvironment` and a real `RestateContainer().alwaysReplay()` with fixture
models. It verifies parallel RPC execution, committed effects occurring once,
feedback propagation, bounded exhaustion, first-success racing, and loser cleanup.
The tests need Docker and make no paid model calls.

To modify a workflow, pass a generator `Model` to its exported factory and exercise
the returned handler through the Restate client. The [example integration tests](../tests/src/examples.integration.ts)
show this setup. Keep assertions on returned results and observable effects, so
changing internal helper functions does not require rewriting the tests.
