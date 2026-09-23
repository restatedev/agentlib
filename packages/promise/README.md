# Promise entry point

Use `@restate-agents/promise` from regular Restate SDK handlers:

```ts
const result = await support.run(ctx, message, {messages});
```

`agent()` owns the coroutine scheduler and delegates execution to core. Each run
binds its own handler context. Its options cover shared model adapters, structured
output, limits, message history, signal names, application context, tool overrides,
and update callbacks.

| Definition         | Callback                        | Result                                                 |
| ------------------ | ------------------------------- | ------------------------------------------------------ |
| `asyncTool(...)`   | `execute(input, metadata)`      | Ordinary `Promise<JsonValue>`, journaled automatically |
| `tool(...)`        | `execute(input, ctx, metadata)` | `RestatePromise<JsonValue>`                            |
| `handlerTool(...)` | `call(input, ctx, metadata)`    | `InvocationPromise<JsonValue>` from a typed SDK client |

Use `asyncTool` for ordinary async I/O. Its callback receives application context,
run/call IDs, the step, and an `AbortSignal`; it runs inside the journal boundary
without an SDK context. Core handles result validation, business errors, and
the optional `retry` policy.

Set `retry: {maxAttempts: 5, initialInterval: {milliseconds: 250}}` on an
`asyncTool` to retry its callback. The default is one attempt. For `tool`, set
retry options on its SDK operations; for `handlerTool`, set `retryPolicy` on
the called service or handler. See [retry policies](../examples/README.md#retry-policies)
for complete examples, model retries, and error behavior.

For `tool` and `handlerTool`, return SDK promises directly: an `async` callback
or `.then()` produces a native promise and is rejected. Use `tool` to compose
SDK operations. Handler tools retain their invocation handles so the core can
cancel unfinished child calls.

Tool `before`, `after`, and dynamic `needsApproval` hooks accept synchronous values
or `RestatePromise`s. Metadata exposes application context, run/call IDs, step,
display information, and available tool names. Core-only generator helpers are
not part of this interface.

Define `onApproval(request, ctx, context)` on the agent or an individual run to
store or publish approval requests. Each request contains `invocationId`,
`signalName`, the tool call, and an optional question. The callback can return
synchronously or return a `RestatePromise<void>`. The agent callback completes
before the run callback, and both complete before the SDK waits for the decision.
For an event bus, return `ctx.run("Publish approval", () => publish(request))`;
external I/O must be journaled so replay does not republish completed work.

The [human-approval lesson](../examples/src/promise/06_human_approval.ts) uses
`needsApproval: true`, stores the request in state from `onApproval`, and resolves
its durable signal from a shared handler. `onApproval` publishes the request;
it does not return a decision. Core's `onHumanApproval` remains an optional override
for the decision mechanism.

Use `@restate-agents/core` for generator composition, conversation
abstractions, and the remaining agent-level generator hooks. The local `adopt` compatibility
helper currently pins the coroutine SDK to 1.17.1.

See the [promise examples](../examples/src/promise) and
[running instructions](../examples/README.md).
