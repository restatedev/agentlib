# Rebuilding the promise SDK

`@restate-agents/promise` let regular, promise-based Restate handlers run agents:

```ts
const result = await support.run(ctx, message, {messages});
```

It was removed to keep one surface while the core API settles. This guide is
for whoever brings it back, human or agent. The last version lives in commit
`61ec2d8` ("Add agentTool for delegating tasks to sub-agents (#5)").

## What it was

A thin adapter (about 400 lines) over `@restate-agents/core`, with no agent
logic of its own. Everything ran on the core generator runtime:

- **`agent(options)`** built a core agent. Each `run(ctx, input, options)` called
  `execute(ctx, gen(...))`, so every run owned its own coroutine scheduler, and
  stored `ctx` in a `contextLocal` so tool callbacks could reach it.
- **`tool`** took a callback returning a `RestatePromise` and adopted it into a
  core `Future`. `async` callbacks and `.then()` were rejected at runtime and in
  the types, because a native promise loses Restate's durable scheduling.
- **`asyncTool`** passed straight through to core's `asyncTool`.
- **`handlerTool`** took a regular-SDK client call returning an
  `InvocationPromise`. It adopted both the result and the `invocationId`
  promise, and returned a `ClientFuture` so core could cancel an unfinished
  child call on interruption.
- **`serviceTool`** reused core's `makeServiceTool` with a regular-SDK
  `MakeCall` (`ctx.client(descriptor, key)[handler](arg)`, then adopted).
- **Hooks** (`before`, `after`, dynamic `needsApproval`, `onApproval`) returned
  a plain value or a `RestatePromise`; `resolveHook` adopted the latter.
- **Types** hid generator-only features: `Tool` was an opaque handle, and
  `ToolContext` kept only `context`, `invocationId`, `name`, `callId`,
  `toolName`, `step`, `info`, and `availableTools`. Run options required
  `context` whenever the agent's context type did.

The key piece was `adopt(promise)` in core (`packages/core/src/adopt.ts`), a
backport of the generator SDK's unreleased `internal.adopt`
([sdk-typescript#797](https://github.com/restatedev/sdk-typescript/pull/797)).
It turned a `RestatePromise` from the same invocation into a `Future` by
swapping the backing of a channel's future through a private SDK symbol. That
is why `@restatedev/restate-sdk-gen` is pinned to an exact version.

## Steps

1. **Check upstream first.** If the generator SDK now exports `adopt` (or an
   equivalent way to await a regular-SDK promise inside a coroutine), use it
   instead of the backport and drop the exact version pin.
2. **Restore the files:**

   ```sh
   git checkout 61ec2d8 -- \
     packages/promise \
     packages/core/src/adopt.ts \
     packages/examples/src/promise \
     packages/tests/src/promise.integration.ts
   ```

3. **Re-export from core** (`packages/core/src/index.ts`): `adopt`, and, from
   `service-tool.ts`, `makeServiceTool` and the `MakeCall` type. `serviceTool`
   now builds its call inline; split it back into
   `makeServiceTool(arg, makeCallFor)` plus a generator-SDK `callFor`.
4. **Wire the workspace:**
   - add `"@restate-agents/promise": "workspace:*"` to the examples and tests
     packages, then `pnpm install`;
   - restore the `./promise/*` subpath exports in
     `packages/examples/package.json`, and serve `promiseServices` from
     `packages/examples/src/app.ts`;
   - restore the promise cases in `packages/tests/src/examples.integration.ts`
     and `packages/tests/src/types.ts` (`git show 61ec2d8:<path>` shows them).
5. **Catch up with core.** Diff `packages/core/src/index.ts` against
   `61ec2d8` and decide, for each new export, whether promise users need a
   version. `agentTool`, for example, needs a variant whose sub-agent is a
   promise `Agent`.
6. **Docs:** restore `packages/promise/README.md`, the promise columns and
   `Promise*` service names in `packages/examples/README.md`, the package row
   in the root README, and the `dev:promise` scripts.
7. **Verify** with `pnpm check`. The integration tests cover approvals,
   business errors, cancelling handler calls, and history saved around a run.

## Constraints to keep

- Callbacks must return SDK promises directly. Reject `async` wrappers in both
  the types and at runtime.
- Each run binds its own handler context. Never share a scheduler or `ctx`
  between runs.
- Keep the adapter thin. Behavior belongs in core, so both entry points share
  the same validation, policies, approvals, budgets, and journal layout.
