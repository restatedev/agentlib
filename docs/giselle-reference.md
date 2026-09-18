# Giselle reference: feature map and adoption plan

Historical comparison from 2026-09-18, before the SDK expansion.
The current implementation is mapped in [SDK coverage](sdk-status.md).
`replit-final` remains the golden behavioral reference.

Reviewed on 2026-09-18. The supplied archive contains a project at
`/Users/igalshilman/Downloads/giselle-agents/agent`. Its most relevant component is
[`packages/libs/sdk`](/Users/igalshilman/Downloads/giselle-agents/agent/packages/libs/sdk/README.md),
an extracted, unpublished `@restate-agents/sdk` package. It already implements much
of the proposed SDK surface. Use it as an additional API and implementation reference,
while retaining the stricter lifecycle and protocol checks in our prototype.

## Architecture

`agent.run`, tool execution, policies, approval hooks, and update hooks return
Restate `Operation<T>`. The library registers no services. The embedding handler
owns its invocation, credentials, state, history, and delivery to clients.

The package exposes provider/gateway adaptation, a tool dispatcher, and an agent
loop. MCP and QuickJS program execution have separate entry points. Its model
messages and provider interfaces use Vercel AI SDK types. Our prototype currently
has its own smaller message protocol and an optional OpenAI adapter; adopting the
reference's public types would be an API change, not just moving implementation.

The surrounding application still has its own session loop. Its direct SDK imports
currently reuse the extracted PTC runtime and guest; this does not demonstrate that
the application's full agent lifecycle has migrated to `agent.run`.

## Feature map

| Area                         | Current prototype                                                                            | Giselle SDK reference                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Models and gateways          | Generator model contract, journaled async adapter, OpenAI adapter                            | `AgentModel.generate`, AI SDK providers/gateway IDs, typed Restate gateway adapters                        |
| Tools and context            | Zod input, JSON output, generator execution, required typed run context                      | `tool`, `asyncTool`, `handlerTool`, private context, nested `callTool`                                     |
| Policies and approvals       | Compose guards and signals inside tool generators                                            | Tool `before`/`after`/`needsApproval`; agent `beforeRun`/`beforeStep`/`afterRun`; durable approval signals |
| Parallel execution           | Observe whichever task completes first; preserve result order; interrupt and join on failure | Starts foreground tasks together, then joins them with `all`; see failure finding below                    |
| Background operations        | Planned                                                                                      | Per-tool `background` flag, pending acknowledgments, later completion observations, selective cancellation |
| Built-in tools               | Demo-specific tools outside core                                                             | Durable sleep, approval request, cancellation, Restate handler adapter                                     |
| Programmatic tool calls      | Planned                                                                                      | QuickJS program tool routes nested calls through the normal policies and approval dispatcher               |
| Handoffs                     | Planned                                                                                      | Swap active model/instructions/tools after completing the batch; keep history and root budgets             |
| Progress and streaming       | Generator update hook                                                                        | Generator events, progress, operation-based stream iterator, provider text/reasoning chunks                |
| MCP                          | Planned                                                                                      | Stateless/stateful HTTP adapters; journaled catalog/session metadata; credential and authorization hooks   |
| Integrations                 | OpenAI model adapter                                                                         | Tavily web search; OTel hooks suitable for a configured Braintrust exporter                                |
| Structured output and limits | Text output, bounded steps                                                                   | Zod output schema, repair turns, turn/tool/output limits                                                   |
| Conversations                | Caller supplies and persists history                                                         | Caller supplies and persists `ModelMessage[]`; no reusable conversation storage abstraction                |
| Steering                     | Planned                                                                                      | Absent from the SDK; still implemented in the reference application's session layer                        |

## Semantics worth retaining

- Keep ordinary generator tools distinct from async I/O adapters. The reference's
  `asyncTool` journals expected business failures as data and recreates `ToolError`
  outside `run`, avoiding reliance on error subclass identity surviving replay.
- Use one dispatcher for model calls, PTC calls, and adapters so validation,
  approval, budgets, and output policies have the same meaning on every path.
- Return one protocol result for each model tool call. Background work first
  returns a pending acknowledgment; eventual completion is a separate observation.
- A handoff continues the same task and history. Root budgets remain authoritative;
  existing background work retains the configuration that launched it.
- Separate durable events from live provider chunks. Recorded chunks are emitted
  after the model operation returns and can be reconstructed on replay. A live
  async callback runs inside provider I/O and can repeat after a retry. Raw chunks
  precede final output policies, so they are not a guarded final answer.

## Findings to address before adoption

1. **A later foreground failure waits for earlier work.**
   [`agent.ts:363`](/Users/igalshilman/Downloads/giselle-agents/agent/packages/libs/sdk/src/agent.ts:363)
   joins spawned tasks with `restate.all`. In its pinned coroutine SDK 1.17.0,
   `all` over these tasks awaits them in input order. A probe with a waiting first
   tool and a failing second tool let the first tool finish before surfacing the
   error. An approval wait could therefore postpone failure indefinitely. Preserve
   our completion-driven `select` loop and sibling cleanup, extending it to cover
   background failures as well.
2. **Truncated provider output becomes a successful final answer.**
   [`model.ts:105`](/Users/igalshilman/Downloads/giselle-agents/agent/packages/libs/sdk/src/model.ts:105)
   drops the provider finish reason. A fixture response ending with `length`
   returned `partial answer` as a completed run. Carry the completion reason across
   the model boundary and explicitly reject or report incomplete output before
   declaring success or dispatching ambiguous tool calls.
3. **Cancellation is advisory.**
   The named cancellation signal interrupts current tools and then tells the model
   it may continue. It does not interrupt the current model operation or prevent
   later tool calls. Define steering, graceful stop, selective task cancellation,
   and invocation cancellation as separate contracts before borrowing this API.
4. **Required context is not enforced at the call site.**
   [`RunOptions.context`](/Users/igalshilman/Downloads/giselle-agents/agent/packages/libs/sdk/src/types.ts:133)
   is optional even for an agent declaring a concrete context type; the runtime
   casts it to that type. Keep the prototype's requirement to supply typed context.

The OTel support supplies hooks, not a preconfigured Braintrust integration.
Likewise, the MCP adapters are implemented against protocol fixtures; the presence
of these adapters does not establish compatibility with every external server.

## Implementation order

1. **Establish shared contracts and regression cases.** Decide the public model
   message representation and retain validated model outcomes, required context,
   replay behavior, and prompt sibling cleanup. Add `asyncTool` and a cancellable
   Restate handler adapter with lifecycle tests.
2. **Extend the executor and policy pipeline.** Add run-owned pending operations,
   foreground/background completion handling, explicit stop semantics, tool/run
   policies, and durable approvals. Acceptance cases should include an approval
   wait beside a failing sibling, background failure during foreground work,
   cancellation during model I/O, and replay at each boundary.
3. **Add model and tool integrations through those contracts.** Introduce an AI SDK
   provider adapter and typed gateway adapter. Port MCP, PTC, and common tools
   through the shared dispatcher; keep transport and sandbox dependencies separate
   from the minimal core entry point.
4. **Build higher-level agent composition.** Add handoffs, structured output,
   progress, and an operation-based stream over the same execution loop. Specify
   event identity, backpressure, close/cleanup, and retry/reconnect behavior.
5. **Extract conversation support.** Start with caller-provided in-memory history,
   then an optional `LazyStateConversation` with configurable state keys and
   append-only chunks. Use the reference application's
   [`session/history.ts`](/Users/igalshilman/Downloads/giselle-agents/agent/packages/libs/core/src/session/history.ts)
   for storage ideas, separating model context, public transcript, and compaction.
   The application continues to own its Agent/Session objects and handlers.

The next implementation slice should be the executor, policy, and approval work
in step 2, supported by the contracts and tests in step 1.

## Validation performed

- Copied the SDK into a temporary directory and reused locally cached dependencies;
  no reference files or existing application code were changed.
- All 10 supplied unit tests passed using Restate SDK/gen 1.17.0 and AI SDK 7.0.26.
- SDK source, unit tests, and the support example type-checked.
- Two additional in-process Restate protocol probes reproduced findings 1 and 2.
  The probes intentionally assert the desired behavior and currently fail.
- The supplied Docker-backed always-replay integration suites were inspected but
  not executed. No live provider, MCP server, or paid API was called.

Temporary reproduction:
[`review-probes.test.ts`](/private/tmp/codex-giselle-sdk-HXYwOi/test/review-probes.test.ts).
