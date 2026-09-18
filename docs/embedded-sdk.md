# Embeddable agents on Restate coroutines

The SDK in `packages/core/src` runs inside the caller's Restate coroutine scheduler. Agent
runs, tools, policies, approval callbacks, conversation operations, and update
hooks return `Operation<T>`. Importing the library registers no service or worker.
The embedding application owns invocation routing, authorization, credentials,
state, and delivery to clients.

`replit-final` remains the behavioral reference; Giselle supplies additional API
and adapter patterns. See [feature coverage](sdk-status.md) for the implementation
map, tests, and deliberate boundaries. These are local exports from this private
package, not a published npm release.

## First agent

```ts
import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {agent, tool, type ToolContext} from "@restate-agents/core";
import {openAIModel} from "@restate-agents/core/openai";

type SupportContext = {accountId: string};
const lookupTicket = tool({
  description: "Look up a support ticket",
  input: z.object({ticketId: z.string()}),
  *execute({ticketId}, {context}: ToolContext<SupportContext>) {
    return yield* restate.run(
      async ({signal}) => {
        const response = await fetch(
          `https://support.example.com/accounts/${encodeURIComponent(context.accountId)}/tickets/${encodeURIComponent(ticketId)}`,
          {signal},
        );
        if (!response.ok) throw new Error(`Ticket lookup failed: ${response.status}`);
        return await response.json();
      },
      {name: "Look up ticket", retry: {maxAttempts: 3}},
    );
  },
});

const support = agent<SupportContext>({
  name: "support",
  model: openAIModel({model: process.env.AGENT_MODEL!}),
  instructions: "Help the customer using the available ticket information.",
  tools: {lookupTicket},
  maxSteps: 7,
});

// Place this generator inside any application-owned Restate handler.
function* doTurn(message: string, accountId: string) {
  return yield* support.run(message, {context: {accountId}});
}
```

A definition is reusable across concurrent invocations. Mutable runtime state is
local to each run. A declared context type makes `context` required at the call
site. Context remains host-side unless a tool, instruction, or event explicitly
includes it. Concurrent tools share it, so application mutations need coordination.
Tools, instructions, messages, and results are model-visible.

## Package entry points

Run `pnpm install --frozen-lockfile` and `pnpm build`. The build emits JavaScript and declarations. A local dependency on
this repository can import:

| Import                            | API                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `@restate-agents/core`            | `agent`, `tool`, `asyncTool`, `handlerTool`, `handoff`, model contract, conversations, built-ins |
| `@restate-agents/core/openai`     | `openAIModel` using Chat Completions                                                             |
| `@restate-agents/core/provider`   | `aiModel` using AI SDK providers/gateway IDs, `modelGateway` using Restate RPC                   |
| `@restate-agents/core/program`    | `programTool` and QuickJS limits                                                                 |
| `@restate-agents/core/mcp`        | `mcpTools`                                                                                       |
| `@restate-agents/core/discovery`  | `restateTools` for annotated deployed handlers                                                   |
| `@restate-agents/core/telemetry`  | `otelUpdates`, model tracing helper                                                              |
| `@restate-agents/core/web-search` | `webSearch` using Tavily                                                                         |

Optional entry points separate runtime imports. Their dependencies are currently
installed with this private package; publishing split packages is outside this
implementation.

## Models, gateways, and output

`Model` is `(request: ModelRequest) => Operation<ModelResponse>`. A response is
`{type: "final", text, output?}` or `{type: "tool_calls", calls, text?}`.
Each tool call has `{id, name, input}`. The request carries JSON tool schemas,
messages, instructions, step, and output settings.

`journaledModel(async (request, {signal}) => response)` wraps provider I/O in a
named `restate.run`, validates responses inside the journal boundary, and defaults
to three attempts. `openAIModel` and `aiModel` disable provider-level automatic
retries so Restate owns that policy. Custom generator models must make their own
I/O durable. `modelGateway(request => restate.client(MyGateway).generate(request))`
adapts a typed Restate child call and cancels the child on interruption.

`aiModel({model: providerModel})` uses AI SDK provider protocols without delegating
the agent loop or tool execution. It also accepts AI SDK gateway model identifiers.
Provider-executed tools are rejected: tools must pass through the Restate dispatcher.
Truncation, refusal, malformed calls, duplicate IDs, and ambiguous batches fail
before tools dispatch. No implicit fallback model is chosen.

Pass `output: z.object({...})` to request typed structured output. Invalid final
candidates produce repair observations and consume the existing step budget.
The final value is validated again after output policies. JSON-compatible schemas
and synchronous validation are required; put asynchronous checks in generators.

## Tool execution, policies, and approvals

Every direct or nested tool call uses the same dispatcher:

1. Root and active-agent `beforeTool` policy.
2. Input schema validation, tool `before`, and `needsApproval`.
3. Generator `execute`, tool `after`, active-agent and root `afterTool`.
4. JSON/output-limit validation and completion event.

A policy returns `true`/`undefined` to allow, or `false`/a reason string to deny.
Tool denials become observations the model can handle. `beforeRun` runs before
compaction or inference; `beforeStep` sees each request; `afterRun` can reject or
rewrite the final result. The runtime owns protocol history and stores the guarded
answer. Steering received while an asynchronous output policy runs triggers
replanning before that candidate is published.

`tool({... *execute() {...}})` composes directly with Restate state, sleeps,
signals, calls, and spawned tasks. Put ordinary network I/O in `restate.run`.
`asyncTool` adds that boundary for Promise-based I/O and defaults to one attempt.
It preserves expected `ToolError` failures as journaled data. `handlerTool`
adapts a Restate `ClientFuture` and propagates cancellation to the child invocation.

Use `needsApproval: true` or a generator predicate. An `approval-required` event
contains the call and a stable `signalName`. By default execution waits on a durable
boolean signal addressed to the current invocation. Only `true` approves. Override
`onHumanApproval(request, toolContext)` to embed your own approval workflow. An
application control endpoint must authorize the caller and verify that the request
belongs to the active run. `packages/examples/src/ai-session.ts` demonstrates active-request checks.

Expected business errors use `ToolError`; invalid arguments and unknown tools
also become structured observations. Unexpected errors and failing hooks fail the
run, interrupt siblings, and join their cleanup. Do not throw a custom error class
inside a raw `restate.run` and assume its identity survives replay; return outcome
data or use `asyncTool`.

## Parallel work and lifecycle controls

Foreground calls start concurrently. Completions are observed as they arrive,
while tool-response messages remain in request order. A later failure wakes the
parent even if an earlier tool is waiting on human approval.

A tool with `background: true` returns one `{status: "pending", operationId}`
protocol acknowledgment. Its eventual result arrives as a separate runtime
observation. The run cannot declare completion while work remains pending. This
prevents background results and approvals from being silently abandoned.

| Control                         | Behavior                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `steeringSignal`                | Repeated string signals add instructions to the running task. A stale model answer is discarded; completed tool effects are retained. |
| `interruptSignal`               | One string signal stops planning, interrupts current work, joins cleanup, and returns `status: "interrupted"`.                        |
| `cancelOperationTool()`         | Cancels one pending operation while allowing the run to continue.                                                                     |
| Restate invocation cancellation | Propagates cancellation; it is not converted into successful completion.                                                              |
| `stream.close()`                | Interrupts and joins the streamed run.                                                                                                |

Alternatively supply `controls: {steering: () => future, interrupt: future}` to
compose with your own Restate futures. Built-in durable helpers include
`sleepTool`, `humanApprovalTool`, `cancelOperationTool`, and `searchToolsTool`.

The default limits are 10 model steps, 128 tool calls including nested calls,
16 levels of nested dispatch, 4,096 requested output tokens, and 128,000 output
characters. Limits are configurable. Step exhaustion returns
`{status: "stopped", reason: "max_steps", steps, messages}` after cleanup.
Optional `finalize: model` adds one tool-free summary call after stop/interruption;
it is separate from the planning budget. A failed summary returns honest fallback
text. Native invocation cancellation still propagates.

`handoff(specialist)` is a foreground tool that switches model, instructions, and
catalog after its batch settles. History, context, root tool policies, final output
policy, and budgets continue. Existing background tasks keep their launching
catalog. Run-specific tools are not implicitly copied into the specialist.
Nested/programmatic handoffs are rejected. The root owns run-level policies;
the specialist contributes instructions, model, tools, step/tool policies, and
approval behavior.

## Search and programmatic tool calling

Mark infrequently needed tools `deferred: true` and register
`searchTools: searchToolsTool()`. Only eager and previously loaded schemas enter
the model request. Search indexes permitted tool names, providers, descriptions,
and parameter names; results are journaled and loaded for subsequent steps.
Search state is local to the run. Without a search tool, all schemas are exposed.
Deferral reduces prompt size; authorization comes from the allowed catalog and
policies, not from whether a tool has been searched.

```ts
import {programTool} from "@restate-agents/core/program";
// Include in agent.tools:
const program = programTool({tools: ["lookupTicket"]});
// The model supplies e.g.:
// {source: 'async tools => await Promise.all([tools.lookupTicket({ticketId:"A"}), tools.lookupTicket({ticketId:"B"})])'}
```

The QuickJS guest supports `Promise.all`, `any`, `race`, and `allSettled`. It has
no host network/filesystem/process, timers, wall-clock time, or randomness.
Memory, stack, source, results, calls, CPU interrupts, and microtask work are bounded.
Every nested call passes through validation, approval, policies, and root budgets.
Returning from the program cancels and joins unfinished children. Business failures
are catchable guest rejections; infrastructure failure remains a run failure.
With no explicit `tools` option, the guest receives the permitted run catalog
except the program tool itself.

## MCP and Restate tool discovery

Call `yield* mcpTools({url, namespace, protocol, ...})` in the embedding handler,
then pass the returned `tools` to `agent.run`. `protocol` is explicitly `stateless`
(pinned to MCP 2026-07-28) or `stateful` (initialized session). Catalog and session
metadata are journaled; HTTP clients are reconstructed for I/O. An expired stateful
session fails rather than silently initializing a different session.

`allow(remoteName)` filters before exposure; tools are deferred by default.
Namespaced aliases are stable, including invalid remote-name normalization.
`token()` is a generator and `onAuthorizationRequired()` can perform durable
credential refresh or wait for user authorization. The host supplies OAuth flows
and secret storage. Refresh attempts are bounded. Call `close()` when the host
finishes with a stateful session. Transport timeout, result size, catalog size,
argument validation, abort signals, and idempotency headers are enforced. The
remote service must honor idempotency to prevent duplicate external effects.

`restateTools({adminUrl, allow, reservedNames})` snapshots handlers carrying
`restate.dev/agent` metadata. Input schemas are preserved; keyed handlers receive
`{key, input}`. Unsupported schemas and duplicate names return warnings. The
allow callback applies application permissions before tools enter search or PTC.
Both adapters return ordinary tools and use the same dispatcher.

## Conversations and compaction

Supply either `messages` or a `Conversation`. Input history is copied and validated;
each assistant tool call must have exactly one matching response. Context messages
contain tool inputs and results, so they are not a public UI transcript.

```ts
const conversation = new LazyStateConversation({
  metaKey: "meta",
  stateKey: "convo",
  compaction: {model, policy: {maxMessages: 64, maxChars: 64000, retainMessages: 12}},
});
const result = yield * support.run(message, {context, conversation});
```

The default store uses the embedding Virtual Object's state. Use one exclusive
writer per conversation; shared handlers may read history. A custom
`ConversationStore` supplies generator `get` and `set`. Chunks hold 32 messages;
metadata carries the append version and optional summary boundary. Completed
exchanges are persisted between steps, and stale versions are rejected.

Automatic compaction runs at the beginning of an accepted run. It summarizes a
complete prefix without splitting tool-call/result pairs, keeps the suffix, and
retains the full raw log for `page(from, limit)`. The summary is model-context data,
not a new system instruction. For application-scheduled compaction, compose
`prepareCompaction`, `summarizeConversation`, and `applyCompaction`: new appends are
allowed while summarizing; overlapping stale summaries cannot overwrite a newer
one. Compaction is not a token-exact context-window guarantee and is not run after
every model step.

## Updates, streaming, and telemetry

`onUpdate` is a pluggable generator. Events include step/tool start and completion,
pending work, approval, progress, steering, handoff, invalid output, model chunks,
and run end. Events have monotonically increasing sequences and stable IDs based
on invocation, run name, and sequence. Give multiple runs in one invocation distinct
names. Hooks can overlap; order external events by sequence and deduplicate by ID.

Use `yield* agent.stream(...)`, then `yield* stream.next()` until done and
`yield* stream.result` for the result. The queue is bounded to 4,096 events; consume
it while the run progresses. Close it when abandoning a consumer. External updates
must use durable Restate calls or `restate.run`; generator hooks replay.

`aiModel({includeChunks: true})` records text/reasoning chunks and emits them after
the durable model call completes. `onChunk` additionally publishes live provider
chunks inside an I/O attempt. Live delivery can repeat or disappear on a retry;
a `start` event replaces the previous attempt for that step. Raw chunks precede
output policies. Publish the guarded `run-end.output` as the accepted final answer.
The host owns SSE/WebSocket transport, reconnect cursors, and public projections.

`otelUpdates(tracer)` records metadata-only event spans through durable I/O.
`aiModel({tracer})` traces actual provider attempts. Configure an OTel provider and
Braintrust exporter in the host; the SDK does not install a global exporter or
send credentials anywhere automatically. `webSearch({apiKey})` provides bounded
Tavily results as a normal tool.

## Runnable examples and validation

`packages/examples/src/ai-session.ts` is a fuller application-owned `AiSession` Virtual Object with
chunked history, compaction, approvals, PTC, search, background sleep, cancellation,
steering, handoffs, and optional MCP (`MCP_SERVER_URL`, `MCP_PROTOCOL`, `MCP_TOKEN`).
Its ticket tools are examples; they do not mutate an external ticketing system.
Set `OPENAI_API_KEY` and optionally `AGENT_MODEL` before invoking a model-backed turn.

```sh
pnpm typecheck
pnpm test
pnpm build
ppnpm test:integration   # requires a running Docker daemon; temporary Restate container
pnpm dev
# Register/rediscover http://localhost:9080 with your Restate server.
curl localhost:8080/AiSession/example/doTurn/send --json '{"message":"Find ticket A and ask the specialist to close it"}'
curl localhost:8080/AiSession/example/status --json 'null'
curl localhost:8080/AiSession/example/steer --json '"Also summarize the outcome"'
# Use the signalName returned by status.approvals:
curl localhost:8080/AiSession/example/approve --json '{"signalName":"<pending signal>","approved":true}'
curl localhost:8080/AiSession/example/interrupt --json '"Stop this task"'
curl localhost:8080/AiSession/example/history --json 'null'
```

The suites exercise real coroutine scheduling, complete/partial journals, mock
provider/MCP protocols, and an actual Restate server with forced replay. They make
no paid model or remote MCP calls. Provider credentials, real server compatibility,
and the host's authorization/delivery setup require deployment-specific validation.

Completed journaled effects are reused on replay. An external effect can repeat
if its result was not committed: use stable idempotency keys for mutations. Keep
in-flight deployments compatible with their journals when changing code or schemas.
