# Promise entry point

Use `@restate-agents/promise` from regular Restate SDK handlers:

```ts
const result = await support.run(ctx, message, {messages});
```

`agent()` owns the coroutine scheduler and delegates execution to core. Each run
binds its own handler context. Its options cover shared model adapters, structured
output, limits, message history, signal names, application context, and tool overrides.

| Definition         | Callback                        | Result                                                 |
| ------------------ | ------------------------------- | ------------------------------------------------------ |
| `tool(...)`        | `execute(input, ctx, metadata)` | `RestatePromise<JsonValue>`                            |
| `handlerTool(...)` | `call(input, ctx, metadata)`    | `InvocationPromise<JsonValue>` from a typed SDK client |

Return SDK promises directly: an `async` callback or `.then()` produces a native
promise and is rejected. Use `ctx.run(...)` to journal ordinary I/O. Handler tools
retain their invocation handles so the core can cancel unfinished child calls.

Tool `before`, `after`, and dynamic `needsApproval` hooks accept synchronous values
or `RestatePromise`s. Metadata exposes application context, run/call IDs, step,
display information, and available tool names. Core-only generator helpers are
not part of this interface.

Use `@restate-agents/core` for generator composition, streaming, conversation
abstractions, and agent-level coroutine hooks. The local `adopt` compatibility
helper currently pins the coroutine SDK to 1.17.1.

See the [promise examples](../examples/src/promise) and
[running instructions](../examples/README.md).
