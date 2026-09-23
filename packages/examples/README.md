# Agent tutorial

Read the numbered files in [src/gensdk](src/gensdk) from `01` onward. Each file
stands alone; you do not need to import or edit previous lessons. Lessons 01–10
build up the agent and workflow primitives. The later lessons are goal-based
recipes you can read in any order. [services.ts](src/gensdk/services.ts) lists
the services in tutorial order, [app.ts](src/app.ts) serves them, and
[shared.ts](src/shared.ts) configures the model.

Each prompt handler declares a Zod input schema with a scenario-specific
default for the request editor. The research example also supplies demo sources. Rediscover
the endpoint after changing a schema so Restate receives the updated defaults.
String bodies use `.meta({default: ...})` to prefill the editor while keeping
the request body required; object fields use `.default(...)`.

| Lesson | New concept                           | Source                                                            |
| ------ | ------------------------------------- | ----------------------------------------------------------------- |
| 01     | One agent, one request                | [01_hello.ts](src/gensdk/01_hello.ts)                             |
| 02     | A tool with validated arguments       | [02_tools.ts](src/gensdk/02_tools.ts)                             |
| 03     | Conversation history between requests | [03_conversation.ts](src/gensdk/03_conversation.ts)               |
| 04     | Validated, typed output               | [04_structured_output.ts](src/gensdk/04_structured_output.ts)     |
| 05     | A bounded draft-and-review loop       | [05_evaluator_optimizer.ts](src/gensdk/05_evaluator_optimizer.ts) |
| 06     | Human approval                        | [06_human_approval.ts](src/gensdk/06_human_approval.ts)           |
| 07     | Concurrent agents                     | [07_racing_agents.ts](src/gensdk/07_racing_agents.ts)             |
| 08     | Parallel worker RPCs and synthesis    | [08_research_report.ts](src/gensdk/08_research_report.ts)         |
| 09     | Handoffs and session controls         | [09_support_session.ts](src/gensdk/09_support_session.ts)         |
| 10     | A whole Restate service as one tool   | [10_service_tool.ts](src/gensdk/10_service_tool.ts)               |
| 11     | A coding agent in a remote sandbox    | [11_coding_agent.ts](src/gensdk/11_coding_agent.ts)               |
| 12     | Route to a specialist                 | [12_routing.ts](src/gensdk/12_routing.ts)                         |
| 13     | Enforce a tool policy                 | [13_tool_guardrail.ts](src/gensdk/13_tool_guardrail.ts)           |
| 14     | Search the public web                 | [14_web_search.ts](src/gensdk/14_web_search.ts)                   |

If you have a specific goal, start here:

| Goal                                | Smallest lesson                        |
| ----------------------------------- | -------------------------------------- |
| Give an agent an API-backed tool    | [02](src/gensdk/02_tools.ts)           |
| Remember earlier requests           | [03](src/gensdk/03_conversation.ts)    |
| Require a person before a tool runs | [06](src/gensdk/06_human_approval.ts)  |
| Split research across workers       | [08](src/gensdk/08_research_report.ts) |
| Steer or interrupt a running turn   | [09](src/gensdk/09_support_session.ts) |
| Route a request by its meaning      | [12](src/gensdk/12_routing.ts)         |
| Enforce a budget before an action   | [13](src/gensdk/13_tool_guardrail.ts)  |
| Answer with current public sources  | [14](src/gensdk/14_web_search.ts)      |

## Start

From the workspace root, with a Restate server running:

```sh
pnpm install --frozen-lockfile
export OPENAI_API_KEY=...
# Optional: export AGENT_MODEL=...
pnpm dev
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

## 01 — Run your first agent

Start with `agent({model})` and a single handler. The handler passes the request
to the agent and returns its answer as a JSON string. Each call starts with no
conversation history.

```sh
curl --globoff "$RESTATE_CALL_URL/Hello/ask" --json '"Say hello in one sentence."'
```

The response is just the answer, such as `"Hello!"`. The `replyText` helper
extracts the answer from the run result, or returns a short explanation if the
run stopped or was interrupted without producing an answer.

## 02 — Give the agent a tool

Add `instructions` and a `tools` map. `lookupTicket` declares its input with Zod
and returns a fixed demo record. The agent chooses when to call it and uses the
result in its answer.

```sh
curl --globoff "$RESTATE_CALL_URL/TicketLookup/ask" \
  --json '"What is the status of ticket T-42?"'
```

The lesson uses `asyncTool` with an ordinary `async execute(...)` callback.
The SDK journals its result, so you can replace the fixed record with an async
API call directly. The optional second argument supplies application context,
call metadata, and an `AbortSignal` for cancellable I/O.

`describe` is optional. Tool display information defaults to the registered name
(such as `lookupTicket`) and the call arguments; `asyncTool` also uses that name
for its journal step. Add `describe` when you want a custom label or a smaller
selection of display details. It does not change the model-facing `description`.

Both tools set `retry` explicitly: up to five attempts, starting with a 250 ms
retry delay and doubling between attempts. See [retry policies](#retry-policies)
for model calls, individual actions, and handler calls.

Use `tool` when execution needs to compose SDK operations in a generator with
`yield*`. Use `handlerTool` for typed calls to other Restate handlers.

## 03 — Remember previous turns

Change the service to a keyed Restate object. Before the run, load its saved
messages. Pass them to the agent, then save `result.messages` afterward. Return
only the reply; the history stays in object state.

```sh
curl --globoff "$RESTATE_CALL_URL/ChatSession/bob/ask" --json '"My name is Bob."'
curl --globoff "$RESTATE_CALL_URL/ChatSession/bob/ask" --json '"What is my name?"'
```

Both requests use `bob`, so the second sees the first turn. A different key gets
its own history. This lesson stores the full history; the support-session lesson
adds conversation compaction and lifecycle controls.

## 04 — Return structured data

Add an `output` schema to describe the result. The SDK validates the model's
answer and gives the caller the typed object directly.

```sh
curl --globoff "$RESTATE_CALL_URL/TicketTriage/classify" \
  --json '"I was charged twice for my subscription."'
```

A successful response is an object such as
`{"category":"billing","summary":"The customer reports a duplicate subscription charge."}`
without a run-result wrapper. Lesson 05 uses this same mechanism to connect two agents.

## 05 — Compose a draft-and-review loop

One agent returns `{code}`; another returns `{approved, feedback}`. The handler
passes the draft and feedback into the next iteration, stopping at acceptance
or after three attempts. Each stage has a distinct run name.

```sh
curl --globoff "$RESTATE_CALL_URL/CodeReview/generate" \
  --json '{"task":"Read the first item of an array safely, returning undefined when it is empty."}'
```

The response is the accepted code as a string. If all three reviews reject the
draft, the response explains that it still needs work and includes the latest
feedback and code. Acceptance is the model's review decision; the code is
returned as text and never executed. The shared `completedOutput` helper makes
a stopped or interrupted run fail the stage instead of advancing the workflow.

A **run** completes one task; a **step** is one planning model call inside that
run. This loop starts fresh runs for successive drafts. See the
[glossary](../../CONTEXT.md) for the lifecycle terms.

## 06 — Wait for human approval

[The lesson](src/gensdk/06_human_approval.ts) adds `needsApproval: true` to one
`closeTicket` tool. The tool simulates an async API call; no external ticketing
system is involved.

Start a request in one terminal:

```sh
curl --globoff "$RESTATE_CALL_URL/TicketApproval/bob/ask" \
  --json '"Close ticket T-42 after I approve it."'
```

This request waits. Before executing the tool, the SDK calls `onApproval(request)`
and then waits on a durable signal. The lesson saves the request directly in
object state. In a second terminal, inspect it:

```sh
curl --globoff --request POST "$RESTATE_CALL_URL/TicketApproval/bob/status"
```

`status` returns the stored request, containing the proposed tool name and arguments,
plus `invocationId` and `signalName`, or `null` when no request is stored. Copy
both identifiers from the request and submit a decision:

```sh
curl --globoff "$RESTATE_CALL_URL/TicketApproval/bob/approve" --json '{
  "invocationId": "<copy from status>",
  "signalName": "<copy from the same request>",
  "approved": true
}'
```

Approval resumes the waiting tool. The original
`ask` request returns only the agent's reply. To try rejection, start a request
under another key and submit `"approved": false`: the tool is skipped and the
agent receives a denied result. The `approve` handler directly resolves the
supplied invocation's signal and returns `true` to acknowledge sending it.
It does not check whether that request is still pending.

`status` and `approve` are shared handlers, so they run while the exclusive
`ask` handler is waiting. The example stores the latest approval request in one
state entry and clears it after the run returns a result. The SDK has no default
approval timeout; this lesson waits until a decision or invocation cancellation.

`onApproval` is also available on the agent definition. It receives a copy of the
request and the application's run context. The SDK awaits publication before waiting for a decision.
To publish to an event bus, use a journaled `run` operation or a durable service
call in the callback.

## 07 — Race concurrent agents

Spawn two agents and use `restate.any` to take the first successful answer. An
error or exhausted run cannot win. Interrupt and join the other task so its
cleanup finishes before returning; if both fail, return a terminal error.

```sh
curl --globoff "$RESTATE_CALL_URL/RacingAgents/answer" \
  --json '{"question":"How should a durable workflow handle external side effects?"}'
```

The response is the winning answer as a string. Both agents start, so the pattern can
consume more tokens than a single run. They share a model with different
instructions; change their `model` fields to compare providers.

## 08 — Delegate to parallel workers

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

The response is the final report as a string. Worker findings remain internal. This example uses
supplied documents and does not browse the web. Citation IDs are checked against
tool reads; factual quality and final prose still depend on the model.

## 09 — Build a controlled support session

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

`doTurn` returns only the answer or interruption summary. Read conversation
history through `history` and control details through `status` when needed.

The default turn requests a ticket lookup, a handoff, and approval before
closing the demo ticket. `steer` and `interrupt` have example messages too.
For `approve`, copy `invocationId` and `signalName` from `status().approval` and set
`approved` to `true` to allow the action; its default is `false`.

## 10 — Expose a service as one tool

`serviceTool(refundIface)` turns a Restate interface into a single tool. The
model picks a handler (`getPolicy` or `issueRefund`) and passes its input; the
handler descriptions and input schemas come from the interface contract, so no
extra wiring is needed. Pass `{iface, handler: "issueRefund"}` to scope a tool
to one handler instead. Virtual objects and workflows also take a `key`.

```sh
curl --globoff "$RESTATE_CALL_URL/RefundAgent/ask" \
  --json '"Refund order O-99 for $12.50 and tell me the refund policy."'
```

Each call is a durable child invocation. Interrupting the run cancels an
unfinished call, and a failed handler is reported to the model as a tool error.

## 11 — Code in a remote sandbox

`CodingSession` is a virtual object that owns one sandbox per session key. Each
turn reuses the session's sandbox, or creates one inside a journaled step and
stores only its ID. The handler then calls `provider.connect(id)` outside the
journal and passes the handle as run context. That code runs again on every
attempt and after every resume, so each process gets its own connection, and
the handle connects only when a tool first uses it. A replay of steps that are
already journaled never connects at all. `sandboxTools()` gives the agent
`readFile`, `writeFile`, `editFile`, `listFiles`, `search`, `executeCommand`,
and `runInBackground`.

It uses Docker by default, so you only need Docker running. Set
`SANDBOX_PROVIDER=modal` to use [Modal Sandboxes](https://modal.com/docs/guide/sandbox),
with credentials from `modal token new` or `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`,
and `SANDBOX_IMAGE` to change the image (`node:24-bookworm` by default).

```sh
curl --globoff "$RESTATE_CALL_URL/CodingSession/alice/turn" \
  --json '"Create a Node.js module that returns the first n primes, add a node:test test for it, and run the test."'
# While a turn runs, from another terminal:
curl --globoff "$RESTATE_CALL_URL/CodingSession/alice/steer" --json '"Use TypeScript instead of JavaScript."'
# When you are done:
curl --globoff --request POST "$RESTATE_CALL_URL/CodingSession/alice/close"
```

A command runs at most once per tool call. The tool starts it detached in the
sandbox, in a directory named after the call, and waits in short journaled
steps. If the handler crashes or is redeployed mid-command, the retried call
finds that directory and waits for the same process instead of running
`npm install` twice. Long commands survive restarts between wait steps, a
timeout or an interruption stops the whole process group, and output beyond
16 KB keeps its beginning and end, with the full log left in the sandbox.
A non-zero exit code is an ordinary result the model can react to.

After each turn, the session sends itself a `shutdownIfIdle` call delayed by 30
minutes, a durable timer. It terminates the sandbox unless a newer turn has
started by then. `close` terminates it right away.

## 12 — Route a request to a specialist

Use a small structured-output agent to choose `billing`, `account`, or `product`,
then let the chosen specialist answer. The application owns the branch:

```ts
function* answer(question: string) {
  const {specialist} = completedOutput(yield* route.run(question));
  return replyText(yield* specialists[specialist].run(question));
}
```

```sh
curl --globoff "$RESTATE_CALL_URL/SupportRouter/answer" \
  --json '"I cannot log into my account. How can I regain access?"'
```

The specialist starts a fresh run with only the question. Use the handoff in
lesson 09 when the specialist should take over the **same** run and history.

## 13 — Enforce a policy before an action

`bookHotel.before` checks the authoritative quote and budget from application
context before `execute` runs. The model chooses a hotel ID, but cannot set its
price or bypass the limit by supplying a cheaper number. A denied tool call is
returned to the model so it can explain why no booking was made.

```ts
*before({hotelId}, {context}) {
  if (hotelId !== context.hotelId) return "Only the quoted hotel can be booked";
  if (context.quotedTotalCents > context.maxTotalCents)
    return "The quote exceeds the budget";
}
```

```sh
curl --globoff "$RESTATE_CALL_URL/GuardedBooking/ask" \
  --json '{"hotelId":"H-42","quotedTotalCents":12500,"maxTotalCents":10000}'
```

Raise `maxTotalCents` to `15000` to see the allowed path. The reservation is a
demo result; connect a real booking API only after obtaining the quote from your
own trusted service.

## 14 — Answer with current public sources

Set `TAVILY_API_KEY` before starting the example endpoint. `webSearch` sends a
public query to Tavily and journals the bounded results, so a replay does not
repeat the HTTP request. The agent is instructed to cite returned URLs and treat
snippets as evidence, not instructions.

```ts
const researcher = agent({
  model,
  tools: {searchWeb: webSearch({apiKey})},
  instructions: "Search before answering and cite returned URLs.",
});
```

```sh
curl --globoff "$RESTATE_CALL_URL/WebResearch/answer" \
  --json '"Find the current Restate TypeScript SDK docs and cite their URLs."'
```

Keep private data out of search queries. The key stays in application code and
is not part of the model's tool schema. If it is missing, the handler fails with
a clear setup error before calling the model.

## Model configuration

[shared.ts](src/shared.ts) configures the example model. `openAIModel` defaults
GPT-5.6 function-tool requests to `reasoning_effort: "none"` to avoid the default
Luna model's Chat Completions tool/reasoning compatibility error. Explicit model
settings are preserved. Change an agent's `model` field to use another adapter
or gateway.

## Retry policies

Configure retries at the operation that can fail; there is no agent-wide retry
default. `maxSteps` limits the model/tool loop, not retries.

| Operation           | Where to configure it                                  | Example                               |
| ------------------- | ------------------------------------------------------ | ------------------------------------- |
| Ordinary async tool | `asyncTool({retry, ...})`                              | [02_tools.ts](src/gensdk/02_tools.ts) |
| Model call          | `openAIModel({retry, ...})` or `aiModel({retry, ...})` | [shared.ts](src/shared.ts)            |
| Individual action   | `restate.run(action, {name, retry})`                   | Below                                 |
| Handler-backed tool | `retryPolicy` on the called service or handler         | —                                     |

The tool lessons use this policy; the same shape works for model adapters and
individual actions:

```ts
const retry = {
  maxAttempts: 5, // Includes the initial attempt.
  initialInterval: {milliseconds: 250},
  exponentiationFactor: 2,
  maxInterval: {seconds: 5},
  maxDuration: {seconds: 30},
};

// Compose this operation from a handler or tool.
function* performWithRetry() {
  return yield* restate.run(() => performAction(), {name: "Perform action", retry});
}
```

Without an explicit policy, `asyncTool` and the model adapters use three
attempts. A supplied policy replaces that default; specify `maxAttempts` when
you want a fixed attempt limit. The retry duration limits retries, not the
execution time of one attempt. Pass `callId` as an idempotency key for external
writes, since a retried attempt can repeat an effect.

For `asyncTool`, an ordinary thrown `Error` follows the retry policy.
`ToolError` is a business error returned to the model without retrying the
callback; `TerminalError` stops retrying. The policy covers `execute`; SDK
operations in `before` and `after` configure their own retries. Exhausting an
action's retry policy raises a `TerminalError`.

A tool that ends with a `TerminalError` (thrown directly, after exhausted
retries, or from a failed child handler) does not fail the agent. The model
receives `{status: "error", code: "tool_failed", message}` and decides what to
do next. Restate cancellation and agent limits still end the run.

`handlerTool` relies on the called handler's invocation policy: set
`retryPolicy` on the called service or handler, with `onMaxAttempts: "kill"`
to terminate after exhaustion or `"pause"` to leave the invocation paused for
manual intervention.

## Provenance and validation

The advanced workflow lessons adapt patterns from
[`restatedev/ai-examples`](https://github.com/restatedev/ai-examples), inspected at
commit `60d1eda2e5f3aae96db2efeba498e52367a01648`:

| Local example   | Upstream pattern                                                                                                                                                                                      | Changes in this implementation                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Research report | [workflow-orchestrator.ts](https://github.com/restatedev/ai-examples/blob/60d1eda2e5f3aae96db2efeba498e52367a01648/typescript-restate-only/tour-of-agents/src/workflow-orchestrator.ts)               | Typed bounded plan, supplied evidence, source tools and guards, cancellation bridge                    |
| Code review     | [workflow-evaluator-optimizer.ts](https://github.com/restatedev/ai-examples/blob/60d1eda2e5f3aae96db2efeba498e52367a01648/typescript-restate-only/tour-of-agents/src/workflow-evaluator-optimizer.ts) | Structured decisions, previous draft carried forward, explicit exhaustion with the last draft retained |
| Racing agents   | [racing-agents.ts](https://github.com/restatedev/ai-examples/blob/60d1eda2e5f3aae96db2efeba498e52367a01648/typescript-restate-only/tour-of-agents/src/racing-agents.ts)                               | Embedded operations, first completed success, cancellation with joined cleanup                         |

The later goal-based lessons draw on the same patterns described by
[Anthropic's workflow guide](https://www.anthropic.com/engineering/building-effective-agents),
[OpenAI's tool guardrails](https://openai.github.io/openai-agents-python/guardrails/),
and the [AI SDK web-search recipe](https://ai-sdk.dev/cookbook/node/web-search-agent).
They use this library's Restate handlers and tools rather than copying another
framework's control flow.

`pnpm test:integration` registers these exported services with the official
`RestateTestEnvironment` and a real `RestateContainer().alwaysReplay()`. Tests
replace the model adapter import with fixture models using Node's module mocking.
They verify the introductory lessons, approval and denial before effects, rejection of stale decisions,
conversation isolation, parallel RPC execution, committed effects occurring once,
feedback propagation, bounded exhaustion, first-success racing, and loser cleanup.
The tests need Docker and make no paid model calls.

To modify a workflow, edit its agents and handlers directly. The
[example integration tests](../tests/src/examples.integration.ts) invoke those
same exported services through the Restate client and check returned results
and observable effects.
